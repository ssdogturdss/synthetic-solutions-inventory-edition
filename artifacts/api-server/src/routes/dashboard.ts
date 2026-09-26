import { Router, type IRouter } from "express";
import {
  db,
  storesTable,
  inventorySessionsTable,
  inventorySessionItemsTable,
  receivingRecordsTable,
  productsTable,
  categoriesTable,
  chemicalUsageTable,
} from "@workspace/db";
import { eq, desc, and, lt, isNull, count } from "drizzle-orm";
import { requireAuth, getUser, canAccessStore, resolveStoreScope } from "../lib/auth";

const router: IRouter = Router();

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);

  // Fail closed: store users must have an assigned store
  const { denied, storeId: scopedStoreId } = resolveStoreScope(user, res);
  if (denied) return;

  // Total stores (admins see all; store users see 1)
  const allStores = scopedStoreId
    ? await db
        .select()
        .from(storesTable)
        .where(and(eq(storesTable.id, scopedStoreId), eq(storesTable.isActive, true), isNull(storesTable.deletedAt)))
    : await db
        .select()
        .from(storesTable)
        .where(and(eq(storesTable.isActive, true), isNull(storesTable.deletedAt)));
  const storesTotal = allStores.length;

  // Recent finalized sessions
  const sessionFilter = scopedStoreId
    ? and(eq(inventorySessionsTable.status, "finalized"), eq(inventorySessionsTable.storeId, scopedStoreId))
    : eq(inventorySessionsTable.status, "finalized");

  const recentSessions = await db
    .select()
    .from(inventorySessionsTable)
    .where(sessionFilter)
    .orderBy(desc(inventorySessionsTable.finalizedAt))
    .limit(5);

  const storesWithRecentInventory = new Set(recentSessions.map((s) => s.storeId));
  const storesPendingInventory = allStores.filter(
    (s) => !storesWithRecentInventory.has(s.id),
  ).length;

  // Recent receiving — scoped to store user's store
  const receivingFilter = scopedStoreId
    ? and(eq(receivingRecordsTable.storeId, scopedStoreId))
    : undefined;

  const recentReceiving = await db
    .select()
    .from(receivingRecordsTable)
    .where(receivingFilter)
    .orderBy(desc(receivingRecordsTable.receivedAt))
    .limit(5);

  // Active chemical pulls — scoped to store user's store
  const activePullFilter = scopedStoreId
    ? and(eq(chemicalUsageTable.status, "active"), eq(chemicalUsageTable.storeId, scopedStoreId))
    : eq(chemicalUsageTable.status, "active");

  const activePulls = await db
    .select()
    .from(chemicalUsageTable)
    .where(activePullFilter);
  const activeChemicalPulls = activePulls.length;

  // Below minimum count (approximate — use latest sessions)
  let itemsBelowMinimum = 0;
  let itemsOverstocked = 0;
  let totalInventoryValue = 0;

  const products = await db.select().from(productsTable);
  const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

  for (const session of recentSessions) {
    const items = await db
      .select()
      .from(inventorySessionItemsTable)
      .where(eq(inventorySessionItemsTable.sessionId, session.id));

    for (const item of items) {
      const p = productMap[item.productId];
      if (!p) continue;
      const qty = parseFloat(item.estimatedGallons ?? String(item.fullContainers));
      totalInventoryValue += qty * parseFloat(p.cost ?? "0");
      if (p.minLevel && qty < parseFloat(p.minLevel)) itemsBelowMinimum++;
      if (p.maxLevel && qty > parseFloat(p.maxLevel)) itemsOverstocked++;
    }
  }

  // Top chemicals from recent sessions
  const usageByProduct: Record<number, number> = {};
  for (const session of recentSessions) {
    const items = await db
      .select()
      .from(inventorySessionItemsTable)
      .where(eq(inventorySessionItemsTable.sessionId, session.id));
    for (const item of items) {
      const qty = parseFloat(item.estimatedGallons ?? String(item.fullContainers));
      usageByProduct[item.productId] = (usageByProduct[item.productId] ?? 0) + qty;
    }
  }

  const cats = await db.select().from(categoriesTable);
  const catMap = Object.fromEntries(cats.map((c) => [c.id, c.name]));

  const topChemicals = Object.entries(usageByProduct)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
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

  res.json({
    storesTotal,
    storesPendingInventory,
    itemsBelowMinimum,
    itemsOverstocked,
    totalInventoryValue: totalInventoryValue.toFixed(2),
    recentSessions,
    topChemicals,
    recentReceiving,
    activeChemicalPulls,
  });
});

export default router;
