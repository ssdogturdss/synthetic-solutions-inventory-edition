import { Router, type IRouter } from "express";
import {
  db,
  warehousesTable,
  warehouseInventoryMovementsTable,
  warehouseTransfersTable,
  warehouseTransferItemsTable,
  receivingRecordsTable,
  receivingRecordItemsTable,
  storesTable,
  productsTable,
  inventorySessionsTable,
  inventorySessionItemsTable,
} from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { requireAuth, requireAdmin, getUser } from "../lib/auth";
import { logAudit } from "../lib/audit";
import { reconcileStockAlertScope } from "../lib/inventory-alerts";
import { logger } from "../lib/logger";
import { calculateWarehouseStock } from "../lib/warehouse-stock";

const router: IRouter = Router();
const VALID_DECIMAL_RE = /^-?\d+(\.\d+)?$/;

async function getWarehouse(id: number) {
  const [warehouse] = await db
    .select()
    .from(warehousesTable)
    .where(eq(warehousesTable.id, id));
  return warehouse;
}

async function listMovements(req: any, res: any, warehouseId?: number): Promise<void> {
  const { productId, movementType, limit } = req.query as {
    productId?: string;
    movementType?: string;
    limit?: string;
  };
  const conditions = [];
  if (warehouseId !== undefined) {
    conditions.push(eq(warehouseInventoryMovementsTable.warehouseId, warehouseId));
  } else if (req.query.warehouseId) {
    const parsed = parseInt(String(req.query.warehouseId), 10);
    if (!Number.isNaN(parsed)) {
      conditions.push(eq(warehouseInventoryMovementsTable.warehouseId, parsed));
    }
  }
  if (productId) {
    const parsed = parseInt(productId, 10);
    if (!Number.isNaN(parsed)) {
      conditions.push(eq(warehouseInventoryMovementsTable.productId, parsed));
    }
  }
  if (movementType && ["receipt", "transfer", "adjustment"].includes(movementType)) {
    conditions.push(eq(warehouseInventoryMovementsTable.movementType, movementType as "receipt" | "transfer" | "adjustment"));
  }

  let query = db
    .select()
    .from(warehouseInventoryMovementsTable)
    .orderBy(desc(warehouseInventoryMovementsTable.movedAt));
  if (conditions.length) query = query.where(and(...conditions)) as typeof query;
  if (limit) {
    const parsed = parseInt(limit, 10);
    if (!Number.isNaN(parsed) && parsed > 0) query = query.limit(parsed) as typeof query;
  }
  res.json(await query);
}

async function createMovement(req: any, res: any, warehouseIdFromPath?: number): Promise<void> {
  const body = req.body as {
    warehouseId?: number;
    productId?: number;
    quantity?: string | number;
    movementType?: string;
    fromWarehouseId?: number;
    toWarehouseId?: number;
    receivingRecordId?: number;
    notes?: string;
    movedAt?: string;
  };
  const movementType = body.movementType;
  const warehouseId = warehouseIdFromPath ?? body.warehouseId;
  const quantity = String(body.quantity ?? "").trim();

  if (!warehouseId || !body.productId || !quantity || !VALID_DECIMAL_RE.test(quantity)) {
    res.status(400).json({ error: "warehouseId, productId, and a valid quantity are required" });
    return;
  }
  if (!["receipt", "transfer", "adjustment"].includes(movementType ?? "")) {
    res.status(400).json({ error: "movementType must be receipt, transfer, or adjustment" });
    return;
  }
  const parsedQuantity = Number(quantity);
  if (!Number.isFinite(parsedQuantity) || parsedQuantity === 0) {
    res.status(400).json({ error: "quantity must be a non-zero number" });
    return;
  }

  const warehouse = await getWarehouse(warehouseId);
  if (!warehouse || warehouse.deletedAt) {
    res.status(404).json({ error: "Warehouse not found" });
    return;
  }

  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (movementType === "transfer") {
    const fromWarehouseId = body.fromWarehouseId;
    const toWarehouseId = body.toWarehouseId;
    if (!fromWarehouseId || !toWarehouseId || fromWarehouseId === toWarehouseId) {
      res.status(400).json({ error: "Transfers require different fromWarehouseId and toWarehouseId values" });
      return;
    }
    if (warehouseId !== toWarehouseId) {
      res.status(400).json({ error: "warehouseId must match toWarehouseId for a transfer" });
      return;
    }
    const [source, destination] = await Promise.all([
      getWarehouse(fromWarehouseId),
      getWarehouse(toWarehouseId),
    ]);
    if (!source || source.deletedAt || !destination || destination.deletedAt) {
      res.status(404).json({ error: "Source or destination warehouse not found" });
      return;
    }

    const transferGroupId = randomUUID();
    const movedAt = body.movedAt ? new Date(body.movedAt) : new Date();
    if (Number.isNaN(movedAt.getTime())) {
      res.status(400).json({ error: "movedAt must be a valid date" });
      return;
    }
    const writeTransfer = () => db.transaction(async (tx) => {
      const insertedRows = await tx.insert(warehouseInventoryMovementsTable).values([
        {
          warehouseId: fromWarehouseId,
          productId: body.productId!,
          quantity: (-Math.abs(parsedQuantity)).toFixed(3),
          movementType: "transfer",
          transferGroupId,
          fromWarehouseId,
          toWarehouseId,
          employeeId: userId,
          notes: body.notes,
          movedAt,
        },
        {
          warehouseId: toWarehouseId,
          productId: body.productId!,
          quantity: Math.abs(parsedQuantity).toFixed(3),
          movementType: "transfer",
          transferGroupId,
          fromWarehouseId,
          toWarehouseId,
          employeeId: userId,
          notes: body.notes,
          movedAt,
        },
      ]).returning();
      if (insertedRows.length !== 2) {
        throw new Error("Warehouse transfer did not create both movement rows");
      }
      return insertedRows;
    });

    let rows: Awaited<ReturnType<typeof writeTransfer>>;
    try {
      rows = await writeTransfer();
    } catch (error) {
      logger.error({ err: error }, "Failed to create warehouse transfer");
      res.status(500).json({ error: "Unable to create warehouse transfer" });
      return;
    }
    await logAudit(req, "CREATE_WAREHOUSE_TRANSFER", "warehouse_movement", rows[1]?.id ?? 0, null, rows);
    for (const affectedWarehouseId of new Set(rows.map((row) => row.warehouseId))) {
      await reconcileStockAlertScope({
        storeId: null,
        warehouseId: affectedWarehouseId,
        productIds: [body.productId!],
      });
    }
    res.status(201).json({ transferGroupId, movements: rows });
    return;
  }

  if (movementType === "receipt" && parsedQuantity < 0) {
    res.status(400).json({ error: "Receipt quantity must be positive" });
    return;
  }
  const movedAt = body.movedAt ? new Date(body.movedAt) : new Date();
  if (Number.isNaN(movedAt.getTime())) {
    res.status(400).json({ error: "movedAt must be a valid date" });
    return;
  }
  const [movement] = await db
    .insert(warehouseInventoryMovementsTable)
    .values({
      warehouseId,
      productId: body.productId,
      quantity,
      movementType: movementType as "receipt" | "adjustment",
      receivingRecordId: body.receivingRecordId,
      employeeId: userId,
      notes: body.notes,
      movedAt,
    })
    .returning();
  await logAudit(req, "CREATE_WAREHOUSE_MOVEMENT", "warehouse_movement", movement.id, null, movement);
  await reconcileStockAlertScope({
    storeId: null,
    warehouseId: movement.warehouseId,
    productIds: [movement.productId],
  });
  res.status(201).json(movement);
}

router.get("/warehouses", requireAuth, async (_req, res): Promise<void> => {
  const warehouses = await db
    .select()
    .from(warehousesTable)
    .where(isNull(warehousesTable.deletedAt))
    .orderBy(warehousesTable.name);
  res.json(warehouses);
});

router.get("/warehouse-movements", requireAuth, async (req, res): Promise<void> => {
  await listMovements(req, res);
});

router.post("/warehouse-movements", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  await createMovement(req, res);
});

/** Atomically issue stock from a warehouse to a store. */
router.post("/warehouse-transfers", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const user = getUser(req);
  const body = req.body as { sourceWarehouseId?: number; destinationStoreId?: number; notes?: string; items?: Array<{ productId?: number; quantity?: string | number }> };
  if (!body.sourceWarehouseId || !body.destinationStoreId || !Array.isArray(body.items) || !body.items.length) {
    res.status(400).json({ error: "sourceWarehouseId, destinationStoreId, and items are required" }); return;
  }
  const sourceId = body.sourceWarehouseId;
  const storeId = body.destinationStoreId;
  const lines = new Map<number, number>();
  for (const item of body.items) {
    const productId = Number(item.productId);
    const rawQuantity = String(item.quantity ?? "").trim();
    const quantity = Number(rawQuantity);
    if (!Number.isInteger(productId) || !/^\d+(\.\d{1,3})?$/.test(rawQuantity) || !Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ error: "Transfer quantities must be positive and productId must be valid" }); return;
    }
    if (lines.has(productId)) {
      res.status(400).json({ error: "Duplicate product lines are not allowed" }); return;
    }
    lines.set(productId, quantity);
  }
  const [warehouse] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, sourceId));
  const [store] = await db.select().from(storesTable).where(eq(storesTable.id, storeId));
  if (!warehouse || warehouse.deletedAt || warehouse.isActive === false || warehouse.status !== "active") {
    res.status(404).json({ error: "Source warehouse not found or inactive" }); return;
  }
  if (!store || store.deletedAt || store.isActive === false || store.status !== "active") {
    res.status(404).json({ error: "Destination store not found or inactive" }); return;
  }
  const products = await db.select().from(productsTable).where(sql`${productsTable.id} in ${sql.join([...lines.keys()].map((id) => sql`${id}`), sql`, `)}`);
  if (products.length !== lines.size || products.some((p) => !p.isActive || p.deletedAt)) {
    res.status(400).json({ error: "One or more products are missing or inactive" }); return;
  }
  const groupId = randomUUID();
  try {
    const result = await db.transaction(async (tx) => {
      // Transaction-scoped advisory locks serialize issues for each warehouse/product.
      for (const productId of lines.keys()) {
        await tx.execute(sql`select pg_advisory_xact_lock(${sourceId}, ${productId})`);
        const { stock } = await calculateWarehouseStock(tx, sourceId);
        const available = (stock.get(productId)?.milliunits ?? 0) / 1000;
        if (available < (lines.get(productId) ?? 0)) throw new Error("INSUFFICIENT_STOCK");
      }
      const [header] = await tx.insert(warehouseTransfersTable).values({
        transferGroupId: groupId, sourceWarehouseId: sourceId, destinationStoreId: storeId,
        employeeId: user.userId, notes: body.notes,
      }).returning();
      const [receipt] = await tx.insert(receivingRecordsTable).values({
        storeId, employeeId: user.userId, notes: body.notes,
      }).returning();
      const movements = await tx.insert(warehouseInventoryMovementsTable).values([...lines].map(([productId, quantity]) => ({
        warehouseId: sourceId, productId, quantity: (-quantity).toFixed(3), movementType: "transfer" as const,
        transferGroupId: groupId, fromWarehouseId: sourceId, destinationStoreId: storeId,
        employeeId: user.userId, notes: body.notes, movedAt: new Date(),
      }))).returning();
      await tx.insert(receivingRecordItemsTable).values([...lines].map(([productId, quantity]) => ({
        receivingRecordId: receipt.id, productId, quantityReceived: quantity.toFixed(3),
      })));
      await tx.insert(warehouseTransferItemsTable).values([...lines].map(([productId, quantity]) => ({
        transferId: header.id, productId, quantity: quantity.toFixed(3), receivingRecordId: receipt.id,
      })));
      return { header, receipt, movements };
    });
    await logAudit(req, "CREATE_WAREHOUSE_STORE_TRANSFER", "warehouse_transfer", result.header.id, null, result);
    await reconcileStockAlertScope({ storeId, warehouseId: null, productIds: [...lines.keys()] });
    await reconcileStockAlertScope({ storeId: null, warehouseId: sourceId, productIds: [...lines.keys()] });
    res.status(201).json({ transferGroupId: groupId, ...result });
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_STOCK") {
      res.status(409).json({ error: "Insufficient current source warehouse stock" }); return;
    }
    logger.error({ err: error }, "Failed to create warehouse-to-store transfer");
    res.status(500).json({ error: "Unable to create warehouse-to-store transfer" });
  }
});

router.post("/warehouses", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const body = req.body as {
    name?: string;
    warehouseNumber?: string;
    manager?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    phone?: string;
    email?: string;
    notes?: string;
    status?: string;
  };

  if (!body.name?.trim() || !body.warehouseNumber?.trim()) {
    res.status(400).json({ error: "name and warehouseNumber are required" });
    return;
  }

  const [warehouse] = await db
    .insert(warehousesTable)
    .values({
      name: body.name.trim(),
      warehouseNumber: body.warehouseNumber.trim(),
      manager: body.manager,
      address: body.address,
      city: body.city,
      state: body.state,
      zip: body.zip,
      phone: body.phone,
      email: body.email,
      notes: body.notes,
      status: (body.status as "active" | "inactive" | "disabled") ?? "active",
    })
    .returning();

  await logAudit(req, "CREATE_WAREHOUSE", "warehouse", warehouse.id, null, warehouse);
  res.status(201).json(warehouse);
});

router.get("/warehouses/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid warehouse ID" });
    return;
  }

  const [warehouse] = await db
    .select()
    .from(warehousesTable)
    .where(eq(warehousesTable.id, id));

  if (!warehouse || warehouse.deletedAt) {
    res.status(404).json({ error: "Warehouse not found" });
    return;
  }

  res.json(warehouse);
});

router.get("/warehouses/:id/movements", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid warehouse ID" });
    return;
  }
  if (!(await getWarehouse(id))) {
    res.status(404).json({ error: "Warehouse not found" });
    return;
  }
  await listMovements(req, res, id);
});

router.get("/warehouses/:id/stock", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid warehouse ID" }); return; }
  const [warehouse] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, id));
  if (!warehouse || warehouse.deletedAt) { res.status(404).json({ error: "Warehouse not found" }); return; }
  const { count, stock } = await calculateWarehouseStock(db, id);
  res.json([...stock].map(([productId, value]) => ({ warehouseId: id, productId, quantity: (value.milliunits / 1000).toFixed(3), lastCountDate: value.lastCountDate ?? count?.finalizedAt ?? null })));
});

router.post("/warehouses/:id/movements", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid warehouse ID" });
    return;
  }
  await createMovement(req, res, id);
});

router.patch("/warehouses/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid warehouse ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(warehousesTable)
    .where(eq(warehousesTable.id, id));

  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "Warehouse not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const allowed = [
    "name", "warehouseNumber", "manager", "address", "city", "state", "zip",
    "phone", "email", "notes", "status", "isActive",
  ];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  if ("name" in updates && !String(updates.name ?? "").trim()) {
    res.status(400).json({ error: "name cannot be empty" });
    return;
  }
  if ("warehouseNumber" in updates && !String(updates.warehouseNumber ?? "").trim()) {
    res.status(400).json({ error: "warehouseNumber cannot be empty" });
    return;
  }

  const [updated] = await db
    .update(warehousesTable)
    .set(updates as any)
    .where(eq(warehousesTable.id, id))
    .returning();

  await logAudit(req, "UPDATE_WAREHOUSE", "warehouse", id, existing, updated);
  res.json(updated);
});

router.delete("/warehouses/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid warehouse ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(warehousesTable)
    .where(eq(warehousesTable.id, id));

  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "Warehouse not found" });
    return;
  }

  await db
    .update(warehousesTable)
    .set({ deletedAt: new Date(), isActive: false })
    .where(eq(warehousesTable.id, id));

  await logAudit(req, "DELETE_WAREHOUSE", "warehouse", id, existing, null);
  res.sendStatus(204);
});

export default router;