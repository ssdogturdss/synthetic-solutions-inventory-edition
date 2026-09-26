import { Router, type IRouter } from "express";
import {
  db,
  receivingRecordsTable,
  receivingRecordItemsTable,
  warehousesTable,
  warehouseInventoryMovementsTable,
} from "@workspace/db";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { requireAuth, getUser, canAccessStore, resolveStoreScope } from "../lib/auth";
import { logAudit } from "../lib/audit";
import { reconcileStockAlertScope } from "../lib/inventory-alerts";

const router: IRouter = Router();

router.get("/receiving-records", requireAuth, async (req, res): Promise<void> => {
  const { storeId, warehouseId, startDate, endDate, limit } = req.query as {
    storeId?: string;
    warehouseId?: string;
    startDate?: string;
    endDate?: string;
    limit?: string;
  };

  const user = getUser(req);
  const { storeId: scopedStoreId, denied } = resolveStoreScope(user, res);
  if (denied) return;

  const conditions = [];

  if (scopedStoreId !== null) {
    conditions.push(eq(receivingRecordsTable.storeId, scopedStoreId));
  } else if (storeId) {
    const sid = parseInt(storeId, 10);
    if (!isNaN(sid)) conditions.push(eq(receivingRecordsTable.storeId, sid));
  }
  if (warehouseId) {
    const wid = parseInt(warehouseId, 10);
    if (!isNaN(wid)) conditions.push(eq(receivingRecordsTable.warehouseId, wid));
  }

  if (startDate) {
    conditions.push(gte(receivingRecordsTable.receivedAt, new Date(startDate)));
  }
  if (endDate) {
    conditions.push(lte(receivingRecordsTable.receivedAt, new Date(endDate)));
  }

  let query = db
    .select()
    .from(receivingRecordsTable)
    .orderBy(desc(receivingRecordsTable.receivedAt));

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }
  if (limit) {
    const lim = parseInt(limit, 10);
    if (!isNaN(lim)) query = query.limit(lim) as typeof query;
  }

  const records = await query;
  res.json(records);
});

router.post("/receiving-records", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const body = req.body as {
    storeId?: number | null;
    warehouseId?: number;
    vendor?: string;
    invoiceNumber?: string;
    poNumber?: string;
    notes?: string;
    photoUrls?: string[];
    signatureUrl?: string;
    items?: Array<{
      productId: number;
      quantityReceived: string;
      lotNumber?: string;
      cost?: string;
      expirationDate?: string;
    }>;
  };

  if (body.storeId == null && body.warehouseId == null) {
    res.status(400).json({ error: "Either storeId or warehouseId is required" });
    return;
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    res.status(400).json({ error: "items array is required" });
    return;
  }

  if (user.role !== "admin" && body.warehouseId !== undefined) {
    res.status(403).json({ error: "Warehouse receiving is admin-only" });
    return;
  }
  if (body.storeId != null && !canAccessStore(user, body.storeId)) {
    res.status(403).json({ error: "Access denied to this store" });
    return;
  }

  if (body.warehouseId !== undefined) {
    const [warehouse] = await db
      .select()
      .from(warehousesTable)
      .where(eq(warehousesTable.id, body.warehouseId));
    if (
      !warehouse ||
      warehouse.deletedAt ||
      warehouse.isActive === false ||
      warehouse.status !== "active"
    ) {
      res.status(404).json({ error: "Warehouse not found or inactive" });
      return;
    }
  }

  const record = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(receivingRecordsTable)
      .values({
        storeId: body.storeId,
        warehouseId: body.warehouseId,
        employeeId: user.userId,
        vendor: body.vendor,
        invoiceNumber: body.invoiceNumber,
        poNumber: body.poNumber,
        notes: body.notes,
        photoUrls: body.photoUrls,
        signatureUrl: body.signatureUrl,
      })
      .returning();

    await tx.insert(receivingRecordItemsTable).values(
      body.items!.map((item) => ({
        receivingRecordId: created.id,
        productId: item.productId,
        quantityReceived: item.quantityReceived,
        lotNumber: item.lotNumber,
        cost: item.cost,
        expirationDate: item.expirationDate,
      })),
    );

    if (body.warehouseId !== undefined) {
      await tx.insert(warehouseInventoryMovementsTable).values(
        body.items!.map((item) => ({
          warehouseId: body.warehouseId!,
          productId: item.productId,
          quantity: item.quantityReceived,
          movementType: "receipt" as const,
          receivingRecordId: created.id,
          employeeId: user.userId,
          notes: body.notes,
        })),
      );
    }

    return created;
  });

  await logAudit(req, "CREATE_RECEIVING_RECORD", "receiving_record", record.id, null, record);
  if (body.warehouseId !== undefined) {
    await reconcileStockAlertScope({
      storeId: null,
      warehouseId: body.warehouseId,
      productIds: body.items!.map((item) => item.productId),
    });
  }
  res.status(201).json(record);
});

router.get("/receiving-records/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid record ID" });
    return;
  }

  const [record] = await db
    .select()
    .from(receivingRecordsTable)
    .where(eq(receivingRecordsTable.id, id));

  if (!record) {
    res.status(404).json({ error: "Receiving record not found" });
    return;
  }

  const user = getUser(req);
  if (record.storeId !== null && !canAccessStore(user, record.storeId)) {
    res.status(403).json({ error: "Access denied to this store's records" });
    return;
  }
  if (record.storeId === null && user.role !== "admin") {
    res.status(403).json({ error: "Warehouse receiving records are admin-only" });
    return;
  }

  const items = await db
    .select()
    .from(receivingRecordItemsTable)
    .where(eq(receivingRecordItemsTable.receivingRecordId, id));

  res.json({ ...record, items });
});

export default router;
