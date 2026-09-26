import { Router, type IRouter } from "express";
import {
  db,
  inventorySessionsTable,
  inventorySessionItemsTable,
  receivingRecordItemsTable,
  receivingRecordsTable,
  productsTable,
  categoriesTable,
  storesTable,
  warehousesTable,
  warehouseInventoryMovementsTable,
} from "@workspace/db";
import { eq, and, gte, lte, isNull, sql, desc, inArray } from "drizzle-orm";
import { requireAuth, getUser, resolveStoreScope } from "../lib/auth";
import {
  calculateReorderForecast,
  type ReorderForecast,
  type ReorderForecastEvidence,
} from "../lib/reorder-forecast";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Shared consumption helper
// ---------------------------------------------------------------------------

interface ProductConsumption {
  productId: number;
  totalUsage: number;
  storeId: number;
  warehouseId: number | null;
  sessionCount: number;
}

/**
 * Computes true consumption for each product using the accounting formula:
 *   usage per session = prevCount + received_in_window - currentCount
 * across every pair of consecutive finalized sessions for the given stores
 * whose finalizedAt falls within [startDate, endDate].
 */
async function computeConsumption(params: {
  storeId?: string;
  startDate?: string;
  endDate?: string;
}): Promise<ProductConsumption[]> {
  const { storeId, startDate, endDate } = params;

  // Fetch all finalized sessions in range (for the target store(s))
  const sessionConditions: ReturnType<typeof eq>[] = [eq(inventorySessionsTable.status, "finalized")];
  if (storeId) {
    const sid = parseInt(storeId, 10);
    if (!isNaN(sid)) sessionConditions.push(eq(inventorySessionsTable.storeId, sid));
  }
  if (startDate) {
    sessionConditions.push(gte(inventorySessionsTable.finalizedAt, new Date(startDate)));
  }
  if (endDate) {
    sessionConditions.push(lte(inventorySessionsTable.finalizedAt, new Date(endDate)));
  }

  const sessionsInRange = await db
    .select()
    .from(inventorySessionsTable)
    .where(and(...sessionConditions))
    .orderBy(desc(inventorySessionsTable.finalizedAt));

  if (sessionsInRange.length === 0) return [];

  // Group sessions by store
  const byStore: Record<number, typeof sessionsInRange> = {};
  for (const s of sessionsInRange) {
    (byStore[s.storeId] ??= []).push(s);
  }

  // Also fetch ALL finalized sessions (for the same stores) so we can find
  // the previous session that precedes each in-range session
  const allStoreIds = [...new Set(sessionsInRange.map((s) => s.storeId))];
  const allSessions = await db
    .select()
    .from(inventorySessionsTable)
    .where(
      and(
        eq(inventorySessionsTable.status, "finalized"),
        inArray(inventorySessionsTable.storeId, allStoreIds),
      ),
    )
    .orderBy(desc(inventorySessionsTable.finalizedAt));

  type SessionItem = {
    productId: number;
    fullContainers: number;
    partialContainers: number;
    estimatedGallons: string | null;
  };

  // Map sessionId → items (lazy load)
  const sessionItemsCache: Record<number, SessionItem[]> = {};
  async function getSessionItems(sessionId: number): Promise<SessionItem[]> {
    if (!sessionItemsCache[sessionId]) {
      sessionItemsCache[sessionId] = await db
        .select({
          productId: inventorySessionItemsTable.productId,
          fullContainers: inventorySessionItemsTable.fullContainers,
          partialContainers: inventorySessionItemsTable.partialContainers,
          estimatedGallons: inventorySessionItemsTable.estimatedGallons,
        })
        .from(inventorySessionItemsTable)
        .where(eq(inventorySessionItemsTable.sessionId, sessionId));
    }
    return sessionItemsCache[sessionId];
  }

  // Accumulate consumption
  const consumption: Record<string, ProductConsumption> = {};
  // key = `${storeId}:${productId}`

  for (const session of sessionsInRange) {
    // Find the immediately preceding finalized session for this store
    const prevSession = allSessions.find(
      (s) =>
        s.storeId === session.storeId &&
        s.warehouseId === session.warehouseId &&
        s.id !== session.id &&
        (s.finalizedAt?.getTime() ?? 0) < (session.startedAt?.getTime() ?? 0),
    );

    const currentItems = await getSessionItems(session.id);
    const prevItems = prevSession ? await getSessionItems(prevSession.id) : [];
    const prevItemMap = Object.fromEntries(
      prevItems.map((i) => [
        i.productId,
        parseFloat(i.estimatedGallons ?? String(i.fullContainers)),
      ]),
    );

    const windowStart = prevSession?.finalizedAt ?? session.startedAt;

    for (const item of currentItems) {
      const currentCount = parseFloat(
        item.estimatedGallons ?? String(item.fullContainers),
      );
      const prevCount = prevItemMap[item.productId] ?? 0;

      // Received in window: scoped to this store and time window
      const receivedRows = await db
        .select({ qty: receivingRecordItemsTable.quantityReceived })
        .from(receivingRecordItemsTable)
        .innerJoin(
          receivingRecordsTable,
          eq(receivingRecordItemsTable.receivingRecordId, receivingRecordsTable.id),
        )
        .where(
          and(
            eq(receivingRecordItemsTable.productId, item.productId),
            eq(receivingRecordsTable.storeId, session.storeId),
            session.warehouseId != null
              ? eq(receivingRecordsTable.warehouseId, session.warehouseId)
              : isNull(receivingRecordsTable.warehouseId),
            windowStart
              ? sql`${receivingRecordsTable.receivedAt} > ${windowStart}`
              : sql`1=1`,
            sql`${receivingRecordsTable.receivedAt} <= ${session.finalizedAt}`,
          ),
        );

      const received = receivedRows.reduce((acc, r) => acc + parseFloat(r.qty), 0);
      const usage = Math.max(0, prevCount + received - currentCount);

      const key = `${session.storeId}:${item.productId}`;
      if (!consumption[key]) {
        consumption[key] = {
          productId: item.productId,
          storeId: session.storeId,
          warehouseId: session.warehouseId,
          totalUsage: 0,
          sessionCount: 0,
        };
      }
      consumption[key].totalUsage += usage;
      // Only count sessions where actual consumption occurred — zero or
      // uncounted (yellow) boxes are excluded from the per-session average.
      if (usage > 0) consumption[key].sessionCount += 1;
    }
  }

  return Object.values(consumption);
}

type SnapshotLine = {
  productId?: unknown;
  usage?: unknown;
  received?: unknown;
};

function parseUsageSnapshot(value: unknown): SnapshotLine[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((line): line is SnapshotLine => Boolean(line && typeof line === "object"));
}

/**
 * Builds reorder evidence separately from the legacy usage report totals.
 * Forecasts must use the immutable snapshot written when a session was
 * finalized; recomputing from live receiving rows would change historical
 * rates after the fact.
 */
async function computeReorderForecasts(params: {
  storeId?: string;
  startDate?: string;
  endDate?: string;
}): Promise<Map<number, ReorderForecast>> {
  const { storeId, startDate, endDate } = params;
  const conditions: ReturnType<typeof eq>[] = [eq(inventorySessionsTable.status, "finalized")];
  if (storeId) {
    const sid = parseInt(storeId, 10);
    if (!isNaN(sid)) conditions.push(eq(inventorySessionsTable.storeId, sid));
  }
  if (startDate) conditions.push(gte(inventorySessionsTable.finalizedAt, new Date(startDate)));
  if (endDate) conditions.push(lte(inventorySessionsTable.finalizedAt, new Date(endDate)));

  const sessions = await db
    .select()
    .from(inventorySessionsTable)
    .where(and(...conditions))
    .orderBy(desc(inventorySessionsTable.finalizedAt));
  if (sessions.length === 0) return new Map();

  const storeIds = [...new Set(sessions.map((session) => session.storeId))];
  const allSessions = await db
    .select()
    .from(inventorySessionsTable)
    .where(and(
      eq(inventorySessionsTable.status, "finalized"),
      inArray(inventorySessionsTable.storeId, storeIds),
    ))
    .orderBy(desc(inventorySessionsTable.finalizedAt));
  const productIds = [...new Set(
    sessions.flatMap((session) => {
      const snapshot = parseUsageSnapshot(session.usageSummarySnapshot);
      return snapshot?.map((line) => Number(line.productId)).filter(Number.isInteger) ?? [];
    }),
  )];
  const products = productIds.length > 0
    ? await db.select().from(productsTable).where(inArray(productsTable.id, productIds))
    : [];
  const productMap = Object.fromEntries(products.map((product) => [product.id, product]));

  const sessionItems = await db
    .select({
      sessionId: inventorySessionItemsTable.sessionId,
      productId: inventorySessionItemsTable.productId,
      fullContainers: inventorySessionItemsTable.fullContainers,
      estimatedGallons: inventorySessionItemsTable.estimatedGallons,
    })
    .from(inventorySessionItemsTable)
    .where(inArray(inventorySessionItemsTable.sessionId, sessions.map((session) => session.id)));
  const latestSessionByScope: Record<string, number> = {};
  for (const session of sessions) {
    const key = `${session.storeId}:${session.warehouseId ?? "store"}`;
    if (!latestSessionByScope[key]) latestSessionByScope[key] = session.id;
  }
  const currentStockByProduct: Record<number, number> = {};
  for (const item of sessionItems) {
    if (!Object.values(latestSessionByScope).includes(item.sessionId)) continue;
    const quantity = parseFloat(item.estimatedGallons ?? String(item.fullContainers));
    if (Number.isFinite(quantity) && quantity >= 0) {
      currentStockByProduct[item.productId] =
        (currentStockByProduct[item.productId] ?? 0) + quantity;
    }
  }

  const receivingRecordCountByProduct: Record<number, number> = {};
  const receivingConditions: ReturnType<typeof eq>[] = [];
  if (storeId) {
    const sid = parseInt(storeId, 10);
    if (!isNaN(sid)) receivingConditions.push(eq(receivingRecordsTable.storeId, sid));
  } else {
    receivingConditions.push(inArray(receivingRecordsTable.storeId, storeIds));
  }
  if (startDate) receivingConditions.push(gte(receivingRecordsTable.receivedAt, new Date(startDate)));
  if (endDate) receivingConditions.push(lte(receivingRecordsTable.receivedAt, new Date(endDate)));
  const receivingRows = await db
    .select({ productId: receivingRecordItemsTable.productId, recordId: receivingRecordsTable.id })
    .from(receivingRecordItemsTable)
    .innerJoin(
      receivingRecordsTable,
      eq(receivingRecordItemsTable.receivingRecordId, receivingRecordsTable.id),
    )
    .where(and(...receivingConditions));
  for (const row of receivingRows) {
    receivingRecordCountByProduct[row.productId] =
      (receivingRecordCountByProduct[row.productId] ?? 0) + 1;
  }

  const missingSnapshotCount = sessions.filter(
    (session) => parseUsageSnapshot(session.usageSummarySnapshot) === null,
  ).length;
  const evidence = new Map<number, ReorderForecastEvidence>();
  for (const session of sessions) {
    const snapshot = parseUsageSnapshot(session.usageSummarySnapshot);
    if (!snapshot || !session.finalizedAt) continue;
    const previous = allSessions
      .filter((candidate) =>
        candidate.id !== session.id &&
        candidate.storeId === session.storeId &&
        candidate.warehouseId === session.warehouseId &&
        (candidate.finalizedAt?.getTime() ?? 0) < (session.startedAt?.getTime() ?? 0),
      )
      .sort((a, b) => (b.finalizedAt?.getTime() ?? 0) - (a.finalizedAt?.getTime() ?? 0))[0];
    const intervalStart = previous?.finalizedAt ?? session.startedAt;
    const basisDays = intervalStart
      ? (session.finalizedAt.getTime() - intervalStart.getTime()) / 86_400_000
      : 0;
    if (!Number.isFinite(basisDays) || basisDays <= 0) continue;
    for (const line of snapshot) {
      const productId = Number(line.productId);
      const product = productMap[productId];
      const usage = Number(line.usage);
      if (!product || !Number.isFinite(usage) || usage < 0) continue;
      const current = evidence.get(productId) ?? {
        productId,
        productName: product.name,
        unit: product.unit,
        unitCost: product.cost == null ? null : Number(product.cost),
        reorderPoint: product.minLevel == null ? null : Number(product.minLevel),
        targetLevel: product.maxLevel == null ? null : Number(product.maxLevel),
        currentStock: currentStockByProduct[productId] ?? null,
        samples: [],
        missingSnapshotCount,
        receivingRecordCount: receivingRecordCountByProduct[productId] ?? 0,
      };
      current.samples.push({
        usage,
        received: Number(line.received) >= 0 && Number.isFinite(Number(line.received))
          ? Number(line.received)
          : 0,
        basisDays,
        finalizedAt: session.finalizedAt.toISOString(),
      });
      evidence.set(productId, current);
    }
  }
  return new Map(
    products.map((product) => [
      product.id,
      calculateReorderForecast(evidence.get(product.id) ?? {
        productId: product.id,
        productName: product.name,
        unit: product.unit,
        unitCost: product.cost == null ? null : Number(product.cost),
        reorderPoint: product.minLevel == null ? null : Number(product.minLevel),
        targetLevel: product.maxLevel == null ? null : Number(product.maxLevel),
        currentStock: currentStockByProduct[product.id] ?? null,
        samples: [],
        missingSnapshotCount,
        receivingRecordCount: receivingRecordCountByProduct[product.id] ?? 0,
      }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// GET /reports/usage
// ---------------------------------------------------------------------------

router.get("/reports/usage", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const { denied, storeId: scopedId } = resolveStoreScope(user, res);
  if (denied) return;

  const { categoryId, productId, startDate, endDate, period } = req.query as {
    categoryId?: string;
    productId?: string;
    startDate?: string;
    endDate?: string;
    period?: string;
  };

  const storeId: string | undefined =
    scopedId !== null ? String(scopedId) : (req.query.storeId as string | undefined);

  const rows = await computeConsumption({ storeId, startDate, endDate });

  if (rows.length === 0) {
    res.json({
      lines: [],
      reorderForecasts: [],
      period: period ?? "custom",
      startDate: startDate ?? "",
      endDate: endDate ?? "",
      totalCost: "0",
    });
    return;
  }
  const reorderForecasts = await computeReorderForecasts({ storeId, startDate, endDate });

  // Load reference data
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const allProducts = productIds.length > 0
    ? await db.select().from(productsTable).where(inArray(productsTable.id, productIds))
    : [];
  const productMap = Object.fromEntries(allProducts.map((p) => [p.id, p]));

  const cats = await db.select().from(categoriesTable);
  const catMap = Object.fromEntries(cats.map((c) => [c.id, c.name]));

  const storeIds = [...new Set(rows.map((r) => r.storeId))];
  const allStores = storeIds.length > 0
    ? await db.select().from(storesTable).where(inArray(storesTable.id, storeIds))
    : [];
  const storeMap = Object.fromEntries(allStores.map((s) => [s.id, s.name]));
  const visibleReorderForecasts = [...reorderForecasts.values()].filter((forecast) => {
    if (productId && forecast.productId !== parseInt(productId, 10)) return false;
    const product = productMap[forecast.productId];
    return !(categoryId && product?.categoryId !== parseInt(categoryId, 10));
  });

  let totalCost = 0;

  // Aggregate per product (across stores if no storeId filter)
  const aggregated: Record<number, { totalUsage: number; sessionCount: number }> = {};
  for (const row of rows) {
    if (productId && row.productId !== parseInt(productId, 10)) continue;
    const p = productMap[row.productId];
    if (!p) continue;
    if (categoryId && p.categoryId !== parseInt(categoryId, 10)) continue;
    if (!aggregated[row.productId]) aggregated[row.productId] = { totalUsage: 0, sessionCount: 0 };
    aggregated[row.productId].totalUsage += row.totalUsage;
    aggregated[row.productId].sessionCount += row.sessionCount;
  }

  const lines = Object.entries(aggregated).map(([pid, data]) => {
    const p = productMap[Number(pid)];
    const cost = parseFloat(p?.cost ?? "0");
    const lineCost = (data.totalUsage * cost).toFixed(2);
    totalCost += data.totalUsage * cost;
    return {
      productId: Number(pid),
      productName: p?.name ?? "Unknown",
      categoryId: p?.categoryId ?? null,
      categoryName: p?.categoryId ? catMap[p.categoryId] ?? null : null,
      storeId: storeId ? parseInt(storeId, 10) : null,
      storeName: storeId ? (storeMap[parseInt(storeId, 10)] ?? null) : null,
      totalUsage: data.totalUsage.toFixed(3),
      unit: p?.unit ?? null,
      totalCost: lineCost,
      sessionCount: data.sessionCount,
      reorderForecast: reorderForecasts.get(Number(pid)) ?? null,
    };
  });

  res.json({
    lines,
    reorderForecasts: visibleReorderForecasts,
    period: period ?? "custom",
    startDate: startDate ?? "",
    endDate: endDate ?? "",
    totalCost: totalCost.toFixed(2),
  });
});

// ---------------------------------------------------------------------------
// GET /reports/inventory-valuation
// ---------------------------------------------------------------------------

router.get("/reports/inventory-valuation", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const { denied, storeId: scopedId } = resolveStoreScope(user, res);
  if (denied) return;
  const storeId: string | undefined =
    scopedId !== null ? String(scopedId) : (req.query.storeId as string | undefined);
  const warehouseId: string | undefined = req.query.warehouseId as string | undefined;

  // Get the latest finalized session per store
  const storeConditions: ReturnType<typeof eq>[] = [eq(inventorySessionsTable.status, "finalized")];
  if (storeId) {
    const sid = parseInt(storeId, 10);
    if (!isNaN(sid)) storeConditions.push(eq(inventorySessionsTable.storeId, sid));
  }

  const sessions = await db
    .select()
    .from(inventorySessionsTable)
    .where(and(...storeConditions))
    .orderBy(desc(inventorySessionsTable.finalizedAt));

  // Latest session per store. Sessions associated with a warehouse are kept
  // out of the store bucket so the same count is never reported twice.
  const latestByStore: Record<number, typeof sessions[number]> = {};
  for (const s of sessions) {
    if (s.warehouseId == null && !latestByStore[s.storeId]) latestByStore[s.storeId] = s;
  }

  const warehouseConditions: ReturnType<typeof eq>[] = [
    eq(inventorySessionsTable.status, "finalized"),
  ];
  if (storeId) {
    const sid = parseInt(storeId, 10);
    if (!isNaN(sid)) warehouseConditions.push(eq(inventorySessionsTable.storeId, sid));
  }
  if (warehouseId) {
    const wid = parseInt(warehouseId, 10);
    if (!isNaN(wid)) warehouseConditions.push(eq(inventorySessionsTable.warehouseId, wid));
  }
  const warehouseSessions = await db
    .select()
    .from(inventorySessionsTable)
    .where(and(...warehouseConditions))
    .orderBy(desc(inventorySessionsTable.finalizedAt));
  const latestByWarehouse: Record<number, typeof warehouseSessions[number]> = {};
  for (const s of warehouseSessions) {
    if (s.warehouseId != null && !latestByWarehouse[s.warehouseId]) {
      latestByWarehouse[s.warehouseId] = s;
    }
  }

  const products = await db.select().from(productsTable);
  const productMap = Object.fromEntries(products.map((p) => [p.id, p]));
  const stores = await db.select().from(storesTable);
  const storeMap = Object.fromEntries(stores.map((s) => [s.id, s.name]));
  const warehouses = await db.select().from(warehousesTable);
  const warehouseMap = Object.fromEntries(warehouses.map((w) => [w.id, w.name]));

  const movementConditions = [];
  if (warehouseId) {
    const wid = parseInt(warehouseId, 10);
    if (!isNaN(wid)) movementConditions.push(eq(warehouseInventoryMovementsTable.warehouseId, wid));
  }
  const movementQuery = db
    .select()
    .from(warehouseInventoryMovementsTable);
  const movements = movementConditions.length
    ? await movementQuery.where(and(...movementConditions))
    : await movementQuery;
  const receivingFallback = await db
    .select({
      warehouseId: receivingRecordsTable.warehouseId,
      recordId: receivingRecordsTable.id,
      productId: receivingRecordItemsTable.productId,
      quantity: receivingRecordItemsTable.quantityReceived,
      receivedAt: receivingRecordsTable.receivedAt,
    })
    .from(receivingRecordsTable)
    .innerJoin(
      receivingRecordItemsTable,
      eq(receivingRecordItemsTable.receivingRecordId, receivingRecordsTable.id),
    )
    .where(sql`${receivingRecordsTable.warehouseId} is not null`);
  const movementReceivingIds = new Set(
    movements
      .map((movement) => movement.receivingRecordId)
      .filter((id): id is number => id != null),
  );
  const warehouseStock = new Map<string, {
    warehouseId: number;
    productId: number;
    quantity: number;
    lastCountDate: Date | null;
  }>();
  for (const [widText, session] of Object.entries(latestByWarehouse)) {
    const wid = Number(widText);
    const items = await db
      .select()
      .from(inventorySessionItemsTable)
      .where(eq(inventorySessionItemsTable.sessionId, session.id));
    for (const item of items) {
      warehouseStock.set(`${wid}:${item.productId}`, {
        warehouseId: wid,
        productId: item.productId,
        quantity: parseFloat(item.estimatedGallons ?? String(item.fullContainers)),
        lastCountDate: session.finalizedAt,
      });
    }
  }
  for (const movement of movements) {
    const key = `${movement.warehouseId}:${movement.productId}`;
    const current = warehouseStock.get(key);
    if (current && current.lastCountDate && movement.movedAt <= current.lastCountDate) continue;
    warehouseStock.set(key, {
      warehouseId: movement.warehouseId,
      productId: movement.productId,
      quantity: (current?.quantity ?? 0) + parseFloat(movement.quantity),
      lastCountDate: current?.lastCountDate ?? null,
    });
  }
  for (const row of receivingFallback) {
    if (row.warehouseId == null || movementReceivingIds.has(row.recordId)) continue;
    if (warehouseId && row.warehouseId !== parseInt(warehouseId, 10)) continue;
    const key = `${row.warehouseId}:${row.productId}`;
    const current = warehouseStock.get(key);
    if (current && current.lastCountDate && row.receivedAt <= current.lastCountDate) continue;
    warehouseStock.set(key, {
      warehouseId: row.warehouseId,
      productId: row.productId,
      quantity: (current?.quantity ?? 0) + parseFloat(row.quantity),
      lastCountDate: current?.lastCountDate ?? null,
    });
  }

  let grandTotal = 0;
  const lines = [];
  const valuedStoreProducts = new Set<string>();

  for (const [sid, session] of Object.entries(latestByStore)) {
    const items = await db
      .select()
      .from(inventorySessionItemsTable)
      .where(eq(inventorySessionItemsTable.sessionId, session.id));

    for (const item of items) {
      const p = productMap[item.productId];
      if (!p) continue;
      let qty = parseFloat(item.estimatedGallons ?? String(item.fullContainers));
      valuedStoreProducts.add(`${Number(sid)}:${item.productId}`);
      // Receipts (including warehouse-to-store transfers) after the finalized
      // count are part of current store stock; events at the count are not.
      const postCountReceipts = await db
        .select({ quantity: receivingRecordItemsTable.quantityReceived })
        .from(receivingRecordItemsTable)
        .innerJoin(receivingRecordsTable, eq(receivingRecordItemsTable.receivingRecordId, receivingRecordsTable.id))
        .where(and(
          eq(receivingRecordsTable.storeId, Number(sid)),
          eq(receivingRecordItemsTable.productId, item.productId),
          sql`${receivingRecordsTable.receivedAt} > ${session.finalizedAt}`,
        ));
      qty += postCountReceipts.reduce((sum, row) => sum + Number(row.quantity), 0);
      const cost = parseFloat(p.cost ?? "0");
      const totalValue = (qty * cost).toFixed(2);
      grandTotal += qty * cost;
      lines.push({
        productId: p.id,
        productName: p.name,
        storeId: Number(sid),
        storeName: storeMap[Number(sid)] ?? null,
        warehouseId: null,
        warehouseName: null,
        currentQuantity: qty.toFixed(3),
        unit: p.unit,
        unitCost: p.cost,
        totalValue,
      });
    }
  }

  // Include receipt-only products and stores that have never had a finalized
  // count, using a zero baseline. This also covers warehouse-to-store issues.
  const allStoreReceipts = await db.select({
    storeId: receivingRecordsTable.storeId,
    productId: receivingRecordItemsTable.productId,
    quantity: receivingRecordItemsTable.quantityReceived,
    receivedAt: receivingRecordsTable.receivedAt,
  }).from(receivingRecordsTable)
    .innerJoin(receivingRecordItemsTable, eq(receivingRecordItemsTable.receivingRecordId, receivingRecordsTable.id))
    .where(sql`${receivingRecordsTable.storeId} is not null`);
  const receiptOnly = new Map<string, { storeId: number; productId: number; quantity: number }>();
  for (const row of allStoreReceipts) {
    if (row.storeId == null || valuedStoreProducts.has(`${row.storeId}:${row.productId}`)) continue;
    if (storeId && row.storeId !== parseInt(storeId, 10)) continue;
    const count = latestByStore[row.storeId];
    if (count?.finalizedAt && row.receivedAt <= count.finalizedAt) continue;
    const key = `${row.storeId}:${row.productId}`;
    const current = receiptOnly.get(key) ?? { storeId: row.storeId, productId: row.productId, quantity: 0 };
    current.quantity += Number(row.quantity);
    receiptOnly.set(key, current);
  }
  for (const row of receiptOnly.values()) {
    const p = productMap[row.productId];
    if (!p) continue;
    const cost = parseFloat(p.cost ?? "0");
    grandTotal += row.quantity * cost;
    lines.push({
      productId: p.id, productName: p.name, storeId: row.storeId,
      storeName: storeMap[row.storeId] ?? null, warehouseId: null, warehouseName: null,
      currentQuantity: row.quantity.toFixed(3), unit: p.unit, unitCost: p.cost,
      totalValue: (row.quantity * cost).toFixed(2),
    });
  }

  for (const stock of warehouseStock.values()) {
    const p = productMap[stock.productId];
    if (!p || !warehouseMap[stock.warehouseId]) continue;
    const cost = parseFloat(p.cost ?? "0");
    const totalValue = (stock.quantity * cost).toFixed(2);
    grandTotal += stock.quantity * cost;
    lines.push({
      productId: p.id,
      productName: p.name,
      storeId: null,
      storeName: null,
      warehouseId: stock.warehouseId,
      warehouseName: warehouseMap[stock.warehouseId],
      currentQuantity: stock.quantity.toFixed(3),
      unit: p.unit,
      unitCost: p.cost,
      totalValue,
    });
  }

  res.json({ lines, grandTotal: grandTotal.toFixed(2) });
});

// ---------------------------------------------------------------------------
// GET /reports/below-minimum  &  /reports/overstocked
// ---------------------------------------------------------------------------

export async function getStockAlerts(
  storeId: string | undefined,
  type: "below" | "over",
  warehouseId?: string,
) {
  const storeConditions: ReturnType<typeof eq>[] = [
    eq(inventorySessionsTable.status, "finalized"),
    isNull(inventorySessionsTable.warehouseId),
  ];
  if (storeId) {
    const sid = parseInt(storeId, 10);
    if (!isNaN(sid)) storeConditions.push(eq(inventorySessionsTable.storeId, sid));
  }

  const sessions = await db
    .select()
    .from(inventorySessionsTable)
    .where(and(...storeConditions))
    .orderBy(desc(inventorySessionsTable.finalizedAt));

  const latestByStore: Record<number, typeof sessions[number]> = {};
  for (const s of sessions) {
    if (!latestByStore[s.storeId]) latestByStore[s.storeId] = s;
  }

  const products = await db.select().from(productsTable);
  const productMap = Object.fromEntries(products.map((p) => [p.id, p]));
  const stores = await db.select().from(storesTable);
  const storeMap = Object.fromEntries(stores.map((s) => [s.id, s]));

  const alerts = [];

  for (const [sid, session] of Object.entries(latestByStore)) {
    const items = await db
      .select()
      .from(inventorySessionItemsTable)
      .where(eq(inventorySessionItemsTable.sessionId, session.id));

    for (const item of items) {
      const p = productMap[item.productId];
      if (!p) continue;

      let qty = parseFloat(item.estimatedGallons ?? String(item.fullContainers));
      const postCount = await db.select({ quantity: receivingRecordItemsTable.quantityReceived })
        .from(receivingRecordItemsTable)
        .innerJoin(receivingRecordsTable, eq(receivingRecordItemsTable.receivingRecordId, receivingRecordsTable.id))
        .where(and(
          eq(receivingRecordsTable.storeId, Number(sid)),
          eq(receivingRecordItemsTable.productId, item.productId),
          sql`${receivingRecordsTable.receivedAt} > ${session.finalizedAt}`,
        ));
      qty += postCount.reduce((sum, row) => sum + Number(row.quantity), 0);
      const storeInfo = storeMap[Number(sid)];

      if (type === "below" && p.minLevel) {
        const min = parseFloat(p.minLevel);
        if (qty < min) {
          alerts.push({
            productId: p.id,
            productName: p.name,
            storeId: Number(sid),
            storeName: storeInfo?.name ?? "Unknown",
            currentLevel: qty.toFixed(3),
            threshold: p.minLevel,
            unit: p.unit,
            lastCountDate: session.finalizedAt,
          });
        }
      }

      if (type === "over" && p.maxLevel) {
        const max = parseFloat(p.maxLevel);
        if (qty > max) {
          alerts.push({
            productId: p.id,
            productName: p.name,
            storeId: Number(sid),
            storeName: storeInfo?.name ?? "Unknown",
            currentLevel: qty.toFixed(3),
            threshold: p.maxLevel,
            unit: p.unit,
            lastCountDate: session.finalizedAt,
          });
        }
      }
    }
  }

  const storeReceiptBalances = new Map<string, { storeId: number; productId: number; quantity: number }>();
  const countedProducts = new Set<string>();
  for (const [sid, session] of Object.entries(latestByStore)) {
    const items = await db.select().from(inventorySessionItemsTable).where(eq(inventorySessionItemsTable.sessionId, session.id));
    for (const item of items) countedProducts.add(`${Number(sid)}:${item.productId}`);
  }
  const storeReceipts = await db.select({
    storeId: receivingRecordsTable.storeId, productId: receivingRecordItemsTable.productId,
    quantity: receivingRecordItemsTable.quantityReceived, receivedAt: receivingRecordsTable.receivedAt,
  }).from(receivingRecordsTable).innerJoin(receivingRecordItemsTable, eq(receivingRecordItemsTable.receivingRecordId, receivingRecordsTable.id))
    .where(sql`${receivingRecordsTable.storeId} is not null`);
  for (const row of storeReceipts) {
    if (row.storeId == null || countedProducts.has(`${row.storeId}:${row.productId}`)) continue;
    if (storeId && row.storeId !== parseInt(storeId, 10)) continue;
    const count = latestByStore[row.storeId];
    if (count?.finalizedAt && row.receivedAt <= count.finalizedAt) continue;
    const key = `${row.storeId}:${row.productId}`;
    const current = storeReceiptBalances.get(key) ?? { storeId: row.storeId, productId: row.productId, quantity: 0 };
    current.quantity += Number(row.quantity);
    storeReceiptBalances.set(key, current);
  }
  for (const row of storeReceiptBalances.values()) {
    const p = productMap[row.productId];
    const storeInfo = storeMap[row.storeId];
    if (!p || !storeInfo) continue;
    const threshold = type === "below" ? p.minLevel : p.maxLevel;
    if (!threshold) continue;
    const matches = type === "below" ? row.quantity < Number(threshold) : row.quantity > Number(threshold);
    if (matches) alerts.push({
      productId: p.id, productName: p.name, storeId: row.storeId, storeName: storeInfo.name,
      currentLevel: row.quantity.toFixed(3), threshold, unit: p.unit,
      lastCountDate: latestByStore[row.storeId]?.finalizedAt ?? null,
    });
  }

  // Warehouse counts use the same alert thresholds as store counts. Start
  // from the latest warehouse count when one exists, then apply later ledger
  // activity so transfers and receipts are reflected immediately.
  const warehouseSessions = await db
    .select()
    .from(inventorySessionsTable)
    .where(
      and(
        eq(inventorySessionsTable.status, "finalized"),
        sql`${inventorySessionsTable.warehouseId} is not null`,
        ...(storeId
          ? [eq(inventorySessionsTable.storeId, parseInt(storeId, 10))]
          : []),
        ...(warehouseId
          ? [eq(inventorySessionsTable.warehouseId, parseInt(warehouseId, 10))]
          : []),
      ),
    )
    .orderBy(desc(inventorySessionsTable.finalizedAt));
  const latestByWarehouse: Record<number, typeof warehouseSessions[number]> = {};
  for (const session of warehouseSessions) {
    if (session.warehouseId != null && !latestByWarehouse[session.warehouseId]) {
      latestByWarehouse[session.warehouseId] = session;
    }
  }
  const warehouseRows = new Map<string, {
    warehouseId: number;
    productId: number;
    quantity: number;
    lastCountDate: Date | null;
  }>();
  for (const [widText, session] of Object.entries(latestByWarehouse)) {
    const items = await db
      .select()
      .from(inventorySessionItemsTable)
      .where(eq(inventorySessionItemsTable.sessionId, session.id));
    for (const item of items) {
      warehouseRows.set(`${widText}:${item.productId}`, {
        warehouseId: Number(widText),
        productId: item.productId,
        quantity: parseFloat(item.estimatedGallons ?? String(item.fullContainers)),
        lastCountDate: session.finalizedAt,
      });
    }
  }
  const warehouseMovements = await db
    .select()
    .from(warehouseInventoryMovementsTable);
  for (const movement of warehouseMovements) {
    if (warehouseId && movement.warehouseId !== parseInt(warehouseId, 10)) continue;
    const key = `${movement.warehouseId}:${movement.productId}`;
    const current = warehouseRows.get(key);
    if (current?.lastCountDate && movement.movedAt <= current.lastCountDate) continue;
    warehouseRows.set(key, {
      warehouseId: movement.warehouseId,
      productId: movement.productId,
      quantity: (current?.quantity ?? 0) + parseFloat(movement.quantity),
      lastCountDate: current?.lastCountDate ?? null,
    });
  }
  const warehouses = await db.select().from(warehousesTable);
  const warehouseMap = Object.fromEntries(warehouses.map((warehouse) => [warehouse.id, warehouse]));
  for (const row of warehouseRows.values()) {
    const p = productMap[row.productId];
    const warehouse = warehouseMap[row.warehouseId];
    if (!p || !warehouse) continue;
    const threshold = type === "below" ? p.minLevel : p.maxLevel;
    if (!threshold) continue;
    const thresholdValue = parseFloat(threshold);
    const matches = type === "below"
      ? row.quantity < thresholdValue
      : row.quantity > thresholdValue;
    if (matches) {
      alerts.push({
        productId: p.id,
        productName: p.name,
        storeId: null,
        storeName: warehouse.name,
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        currentLevel: row.quantity.toFixed(3),
        threshold,
        unit: p.unit,
        lastCountDate: row.lastCountDate,
      });
    }
  }

  return alerts;
}

router.get("/reports/below-minimum", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const { denied, storeId: scopedId } = resolveStoreScope(user, res);
  if (denied) return;
  const storeId = scopedId !== null ? String(scopedId) : (req.query.storeId as string | undefined);
  const alerts = await getStockAlerts(storeId, "below", req.query.warehouseId as string | undefined);
  res.json(alerts);
});

router.get("/reports/overstocked", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const { denied, storeId: scopedId } = resolveStoreScope(user, res);
  if (denied) return;
  const storeId = scopedId !== null ? String(scopedId) : (req.query.storeId as string | undefined);
  const alerts = await getStockAlerts(storeId, "over", req.query.warehouseId as string | undefined);
  res.json(alerts);
});

// ---------------------------------------------------------------------------
// GET /reports/top-consumers  — uses computeConsumption
// ---------------------------------------------------------------------------

router.get("/reports/top-consumers", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const { denied, storeId: scopedId } = resolveStoreScope(user, res);
  if (denied) return;
  const { startDate, endDate, limit } = req.query as {
    startDate?: string;
    endDate?: string;
    limit?: string;
  };
  const storeId = scopedId !== null ? String(scopedId) : (req.query.storeId as string | undefined);
  const lim = limit ? parseInt(limit, 10) : 10;

  const rows = await computeConsumption({ storeId, startDate, endDate });

  if (rows.length === 0) {
    res.json({ topProducts: [], topStores: [] });
    return;
  }

  const productIds = [...new Set(rows.map((r) => r.productId))];
  const allProducts = await db.select().from(productsTable).where(inArray(productsTable.id, productIds));
  const productMap = Object.fromEntries(allProducts.map((p) => [p.id, p]));
  const cats = await db.select().from(categoriesTable);
  const catMap = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const allStoreIds = [...new Set(rows.map((r) => r.storeId))];
  const allStores = await db.select().from(storesTable).where(inArray(storesTable.id, allStoreIds));
  const storeMap = Object.fromEntries(allStores.map((s) => [s.id, s]));

  // Aggregate by product (all stores combined)
  const byProduct: Record<number, number> = {};
  const byStore: Record<number, { usage: number; sessions: number }> = {};

  for (const row of rows) {
    byProduct[row.productId] = (byProduct[row.productId] ?? 0) + row.totalUsage;
    if (!byStore[row.storeId]) byStore[row.storeId] = { usage: 0, sessions: 0 };
    byStore[row.storeId].usage += row.totalUsage;
    byStore[row.storeId].sessions += row.sessionCount;
  }

  const topProducts = Object.entries(byProduct)
    .sort(([, a], [, b]) => b - a)
    .slice(0, lim)
    .map(([pid, usage]) => {
      const p = productMap[Number(pid)];
      return {
        productId: Number(pid),
        productName: p?.name ?? "Unknown",
        categoryName: p?.categoryId ? catMap[p.categoryId] ?? null : null,
        totalUsage: usage.toFixed(3),
        unit: p?.unit ?? null,
        totalCost: (usage * parseFloat(p?.cost ?? "0")).toFixed(2),
      };
    });

  const topStores = Object.entries(byStore)
    .sort(([, a], [, b]) => b.usage - a.usage)
    .map(([sid, data], i) => {
      const s = storeMap[Number(sid)];
      return {
        storeId: Number(sid),
        storeName: s?.name ?? "Unknown",
        storeNumber: s?.storeNumber ?? "",
        totalUsage: data.usage.toFixed(3),
        totalCost: null,
        sessionCount: data.sessions,
        rank: i + 1,
      };
    });

  res.json({ topProducts, topStores });
});

// ---------------------------------------------------------------------------
// GET /reports/store-rankings  — uses computeConsumption
// ---------------------------------------------------------------------------

router.get("/reports/store-rankings", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const { denied, storeId: scopedId2 } = resolveStoreScope(user, res);
  if (denied) return;
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
  const scopedStoreId = scopedId2;

  const storeId = scopedStoreId !== null ? String(scopedStoreId) : undefined;
  const rows = await computeConsumption({ storeId, startDate, endDate });

  if (rows.length === 0) {
    res.json([]);
    return;
  }

  const allStoreIds = [...new Set(rows.map((r) => r.storeId))];
  const allStores = await db.select().from(storesTable).where(inArray(storesTable.id, allStoreIds));
  const storeMap = Object.fromEntries(allStores.map((s) => [s.id, s]));

  const byStore: Record<number, { usage: number; sessions: number }> = {};
  for (const row of rows) {
    if (!byStore[row.storeId]) byStore[row.storeId] = { usage: 0, sessions: 0 };
    byStore[row.storeId].usage += row.totalUsage;
    byStore[row.storeId].sessions += row.sessionCount;
  }

  const rankings = Object.entries(byStore)
    .sort(([, a], [, b]) => b.usage - a.usage)
    .map(([sid, data], i) => {
      const s = storeMap[Number(sid)];
      return {
        storeId: Number(sid),
        storeName: s?.name ?? "Unknown",
        storeNumber: s?.storeNumber ?? "",
        totalUsage: data.usage.toFixed(3),
        totalCost: null,
        sessionCount: data.sessions,
        rank: i + 1,
      };
    });

  res.json(rankings);
});

export default router;
