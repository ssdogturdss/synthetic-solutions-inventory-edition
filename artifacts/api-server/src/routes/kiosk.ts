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
import { eq, desc, and, isNull, gte } from "drizzle-orm";
import { requireKioskAuth } from "../lib/auth";

const router: IRouter = Router();

/**
 * GET /kiosk/:storeId
 * Public read-only endpoint secured by a kiosk JWT (30-day token).
 * Returns the data needed for the wall-mounted kiosk display.
 */
router.get("/kiosk/:storeId", requireKioskAuth, async (req, res): Promise<void> => {
  const kiosk = (req as typeof req & { kiosk: { storeId: number } }).kiosk;

  const rawId = Array.isArray(req.params.storeId) ? req.params.storeId[0] : req.params.storeId;
  const storeId = parseInt(rawId, 10);

  if (isNaN(storeId)) {
    res.status(400).json({ error: "Invalid store ID" });
    return;
  }

  // Ensure the kiosk token is scoped to the requested store
  if (kiosk.storeId !== storeId) {
    res.status(403).json({ error: "Kiosk token does not match requested store" });
    return;
  }

  const [store] = await db
    .select()
    .from(storesTable)
    .where(eq(storesTable.id, storeId));

  if (!store || store.deletedAt) {
    res.status(404).json({ error: "Store not found" });
    return;
  }

  // Active chemical pulls
  const activePulls = await db
    .select()
    .from(chemicalUsageTable)
    .where(and(eq(chemicalUsageTable.status, "active"), eq(chemicalUsageTable.storeId, storeId)));
  const activeChemicalPulls = activePulls.length;

  // Items below minimum — from most recent finalized session
  const [latestSession] = await db
    .select()
    .from(inventorySessionsTable)
    .where(and(eq(inventorySessionsTable.status, "finalized"), eq(inventorySessionsTable.storeId, storeId)))
    .orderBy(desc(inventorySessionsTable.finalizedAt))
    .limit(1);

  let itemsBelowMinimum = 0;

  if (latestSession) {
    const sessionItems = await db
      .select()
      .from(inventorySessionItemsTable)
      .where(eq(inventorySessionItemsTable.sessionId, latestSession.id));

    const products = await db.select().from(productsTable);
    const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

    for (const item of sessionItems) {
      const p = productMap[item.productId];
      if (!p) continue;
      const qty = parseFloat(item.estimatedGallons ?? String(item.fullContainers));
      if (p.minLevel && qty < parseFloat(p.minLevel)) itemsBelowMinimum++;
    }
  }

  // Last receiving date for this store
  const [lastReceiving] = await db
    .select()
    .from(receivingRecordsTable)
    .where(eq(receivingRecordsTable.storeId, storeId))
    .orderBy(desc(receivingRecordsTable.receivedAt))
    .limit(1);

  const lastReceivingDate = lastReceiving?.receivedAt ?? null;

  // Top 3 chemicals used this week
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const weeklyPulls = await db
    .select()
    .from(chemicalUsageTable)
    .where(and(eq(chemicalUsageTable.storeId, storeId), gte(chemicalUsageTable.pulledAt, weekAgo)));

  const products = await db.select().from(productsTable);
  const productMap = Object.fromEntries(products.map((p) => [p.id, p]));
  const cats = await db.select().from(categoriesTable);
  const catMap = Object.fromEntries(cats.map((c) => [c.id, c.name]));

  const usageByProduct: Record<number, number> = {};
  for (const pull of weeklyPulls) {
    const qty = parseFloat(pull.amountPulled);
    usageByProduct[pull.productId] = (usageByProduct[pull.productId] ?? 0) + qty;
  }

  const topChemicals = Object.entries(usageByProduct)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([pid, usage]) => {
      const p = productMap[Number(pid)];
      return {
        productId: Number(pid),
        productName: p?.name ?? "Unknown",
        categoryName: p?.categoryId ? catMap[p.categoryId] ?? null : null,
        totalUsage: usage.toFixed(3),
        unit: p?.unit ?? null,
      };
    });

  res.json({
    store: { id: store.id, name: store.name, storeNumber: store.storeNumber },
    activeChemicalPulls,
    itemsBelowMinimum,
    lastReceivingDate,
    topChemicals,
    generatedAt: new Date().toISOString(),
  });
});

export default router;
