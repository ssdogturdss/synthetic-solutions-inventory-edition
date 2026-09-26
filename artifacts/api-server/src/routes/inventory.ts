import { Router, type IRouter } from "express";
import {
  db,
  inventorySessionsTable,
  inventorySessionItemsTable,
  receivingRecordItemsTable,
  receivingRecordsTable,
  productsTable,
  warehousesTable,
} from "@workspace/db";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { requireAuth, requireAdmin, getUser, canAccessStore, resolveStoreScope } from "../lib/auth";
import { logAudit } from "../lib/audit";
import { reconcileStockAlertScope } from "../lib/inventory-alerts";

const router: IRouter = Router();

/**
 * Strict full-string match for a non-negative decimal.
 * Accepts "0", "3.500", "12" — rejects "", "1abc", "NaN", "Infinity",
 * "-1", "1.2.3", and any string with leading/trailing non-digit characters.
 */
const VALID_NON_NEGATIVE_DECIMAL_RE = /^\d+(\.\d+)?$/;
function isValidNonNegativeDecimal(s: string): boolean {
  return VALID_NON_NEGATIVE_DECIMAL_RE.test(s.trim());
}

async function computeUsageSummary(
  sessionId: number,
  storeId: number,
  startedAt: Date,
  endAt?: Date | null,
  warehouseId?: number | null,
) {
  const currentItems = await db
    .select()
    .from(inventorySessionItemsTable)
    .where(eq(inventorySessionItemsTable.sessionId, sessionId));

  const [prevSession] = await db
    .select()
    .from(inventorySessionsTable)
    .where(
      and(
        eq(inventorySessionsTable.storeId, storeId),
        eq(inventorySessionsTable.status, "finalized"),
        warehouseId != null
          ? eq(inventorySessionsTable.warehouseId, warehouseId)
          : isNull(inventorySessionsTable.warehouseId),
        sql`${inventorySessionsTable.finalizedAt} < ${startedAt}`,
      ),
    )
    .orderBy(desc(inventorySessionsTable.finalizedAt))
    .limit(1);

  return Promise.all(
    currentItems.map(async (item) => {
      const [product] = await db
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, item.productId));

      let previousCount = "0";
      if (prevSession) {
        const [prevItem] = await db
          .select()
          .from(inventorySessionItemsTable)
          .where(
            and(
              eq(inventorySessionItemsTable.sessionId, prevSession.id),
              eq(inventorySessionItemsTable.productId, item.productId),
            ),
          );
        if (prevItem) {
          // Apply the same NaN/negative guard as for the current item so that
          // pre-validation-era bad data in a prior session doesn't propagate.
          if (prevItem.estimatedGallons != null) {
            const parsedPrev = parseFloat(prevItem.estimatedGallons);
            if (!isFinite(parsedPrev) || parsedPrev < 0) {
              console.warn(
                `[computeUsageSummary] sessionId=${sessionId} productId=${item.productId}: ` +
                `prior-session estimatedGallons="${prevItem.estimatedGallons}" is invalid — ` +
                `falling back to fullContainers=${prevItem.fullContainers}`,
              );
              previousCount = String(prevItem.fullContainers);
            } else {
              previousCount = prevItem.estimatedGallons;
            }
          } else {
            previousCount = String(prevItem.fullContainers);
          }
        }
      }

      const prevFinalizedAt = prevSession?.finalizedAt;
      const windowStart = prevFinalizedAt ?? startedAt;

      const receivedRows = await db
        .select({
          quantityReceived: receivingRecordItemsTable.quantityReceived,
        })
        .from(receivingRecordItemsTable)
        .innerJoin(
          receivingRecordsTable,
          eq(receivingRecordItemsTable.receivingRecordId, receivingRecordsTable.id),
        )
        .where(
          and(
            eq(receivingRecordItemsTable.productId, item.productId),
            eq(receivingRecordsTable.storeId, storeId),
            warehouseId != null
              ? eq(receivingRecordsTable.warehouseId, warehouseId)
              : isNull(receivingRecordsTable.warehouseId),
            windowStart
              ? sql`${receivingRecordsTable.receivedAt} > ${windowStart}`
              : sql`1=1`,
            endAt
              ? sql`${receivingRecordsTable.receivedAt} <= ${endAt}`
              : sql`1=1`,
          ),
        );

      const received = receivedRows
        .reduce((acc, r) => {
          const qty = parseFloat(r.quantityReceived);
          if (!isFinite(qty) || qty < 0) {
            console.warn(
              `[computeUsageSummary] sessionId=${sessionId} productId=${item.productId}: ` +
              `invalid quantityReceived="${r.quantityReceived}" — treating as 0`,
            );
            return acc;
          }
          return acc + qty;
        }, 0)
        .toFixed(3);

      // Resolve currentCount, falling back to fullContainers when estimatedGallons
      // is present but not a valid decimal (e.g. empty string, "N/A", or "NaN").
      let currentCount: string;
      if (item.estimatedGallons != null) {
        const parsed = parseFloat(item.estimatedGallons);
        if (!isFinite(parsed) || parsed < 0) {
          console.warn(
            `[computeUsageSummary] sessionId=${sessionId} productId=${item.productId}: ` +
            `estimatedGallons="${item.estimatedGallons}" is not a valid non-negative decimal — ` +
            `falling back to fullContainers=${item.fullContainers}`,
          );
          currentCount = String(item.fullContainers);
        } else {
          currentCount = item.estimatedGallons;
        }
      } else {
        currentCount = String(item.fullContainers);
      }

      const prev = parseFloat(previousCount);
      const rec = parseFloat(received);
      const curr = parseFloat(currentCount);
      const usage = Math.max(0, prev + rec - curr).toFixed(3);

      return {
        productId: item.productId,
        productName: product?.name ?? "Unknown",
        previousCount,
        received,
        currentCount,
        usage,
      };
    }),
  );
}

router.get("/inventory-sessions", requireAuth, async (req, res): Promise<void> => {
  const { storeId, warehouseId, status, limit } = req.query as {
    storeId?: string;
    warehouseId?: string;
    status?: string;
    limit?: string;
  };

  const user = getUser(req);
  const { storeId: scopedStoreId, denied } = resolveStoreScope(user, res);
  if (denied) return;

  const conditions = [];

  if (scopedStoreId !== null) {
    // Store user — always scope to their own store
    conditions.push(eq(inventorySessionsTable.storeId, scopedStoreId));
  } else if (storeId) {
    const sid = parseInt(storeId, 10);
    if (!isNaN(sid)) conditions.push(eq(inventorySessionsTable.storeId, sid));
  }
  if (warehouseId) {
    const wid = parseInt(warehouseId, 10);
    if (!isNaN(wid)) conditions.push(eq(inventorySessionsTable.warehouseId, wid));
  }
  if (status === "open" || status === "finalized") {
    conditions.push(eq(inventorySessionsTable.status, status));
  }

  let query = db
    .select()
    .from(inventorySessionsTable)
    .orderBy(desc(inventorySessionsTable.createdAt));

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  if (limit) {
    const lim = parseInt(limit, 10);
    if (!isNaN(lim)) query = query.limit(lim) as typeof query;
  }

  const sessions = await query;
  res.json(sessions);
});

router.post("/inventory-sessions", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const { storeId, warehouseId, notes } = req.body as {
    storeId?: number;
    warehouseId?: number;
    notes?: string;
  };

  if (!storeId) {
    res.status(400).json({ error: "storeId is required" });
    return;
  }

  if (warehouseId !== undefined) {
    const [warehouse] = await db
      .select()
      .from(warehousesTable)
      .where(eq(warehousesTable.id, warehouseId));
    if (!warehouse || warehouse.deletedAt) {
      res.status(404).json({ error: "Warehouse not found" });
      return;
    }
  }

  // Store users must have an assigned store and can only create sessions for it
  if (user.role === "store_user") {
    if (!user.storeId) {
      res.status(403).json({ error: "Store user account has no assigned store" });
      return;
    }
    if (user.storeId !== storeId) {
      res.status(403).json({ error: "Cannot create session for another store" });
      return;
    }
  }

  const [session] = await db
    .insert(inventorySessionsTable)
    .values({
      storeId,
      warehouseId,
      employeeId: user.userId,
      notes,
    })
    .returning();

  await logAudit(req, "CREATE_INVENTORY_SESSION", "inventory_session", session.id, null, session);
  res.status(201).json(session);
});

router.get("/inventory-sessions/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const [session] = await db
    .select()
    .from(inventorySessionsTable)
    .where(eq(inventorySessionsTable.id, id));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const user = getUser(req);
  if (!canAccessStore(user, session.storeId)) {
    res.status(403).json({ error: "Access denied to this store's sessions" });
    return;
  }

  const items = await db
    .select()
    .from(inventorySessionItemsTable)
    .where(eq(inventorySessionItemsTable.sessionId, id));

  // Find the immediately preceding finalized session for this store so the
  // client can show "last count" reference values for each product.
  const [prevSession] = await db
    .select()
    .from(inventorySessionsTable)
    .where(
      and(
        eq(inventorySessionsTable.storeId, session.storeId),
        eq(inventorySessionsTable.status, "finalized"),
        sql`${inventorySessionsTable.finalizedAt} < ${session.startedAt}`,
      ),
    )
    .orderBy(desc(inventorySessionsTable.finalizedAt))
    .limit(1);

  const previousItems = prevSession
    ? await db
        .select()
        .from(inventorySessionItemsTable)
        .where(eq(inventorySessionItemsTable.sessionId, prevSession.id))
    : null;

  // For finalized sessions, serve the snapshot stored at finalization time so
  // that receiving records posted after the session closed never alter
  // historical figures.  Fall back to live recomputation only for legacy rows
  // finalized before the snapshot column was introduced.
  const usageSummary =
    session.status === "finalized"
      ? (session.usageSummarySnapshot as Awaited<ReturnType<typeof computeUsageSummary>> | null) ??
        await computeUsageSummary(id, session.storeId, session.startedAt, session.finalizedAt, session.warehouseId)
      : null;

  res.json({ ...session, items, previousItems, usageSummary });
});

router.post("/inventory-sessions/:id/finalize", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const [session] = await db
    .select()
    .from(inventorySessionsTable)
    .where(eq(inventorySessionsTable.id, id));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const user = getUser(req);
  if (!canAccessStore(user, session.storeId)) {
    res.status(403).json({ error: "Access denied to this store's sessions" });
    return;
  }

  // Store users may only finalize sessions they personally created.
  // Admins can finalize any session regardless of creator.
  if (user.role === "store_user" && session.employeeId !== user.userId) {
    res.status(403).json({ error: "Store users can only finalize sessions they created" });
    return;
  }

  if (session.status === "finalized") {
    res.status(400).json({ error: "Session already finalized" });
    return;
  }

  const now = new Date();

  // Compute usage summary before marking finalized (items are still current).
  // Pass `now` as the end boundary so receiving records added after this moment
  // are excluded — keeping the result consistent with future GET reads.
  const usageSummary = await computeUsageSummary(id, session.storeId, session.startedAt, now, session.warehouseId);

  // Mark session finalized and store the usage snapshot atomically so that
  // subsequent GETs always return the same figures regardless of receiving
  // records posted after this moment.
  const [finalized] = await db
    .update(inventorySessionsTable)
    .set({ status: "finalized", finalizedAt: now, usageSummarySnapshot: usageSummary })
    .where(eq(inventorySessionsTable.id, id))
    .returning();

  const finalizedItems = await db
    .select()
    .from(inventorySessionItemsTable)
    .where(eq(inventorySessionItemsTable.sessionId, id));

  await logAudit(req, "FINALIZE_INVENTORY_SESSION", "inventory_session", id, session, finalized);
  await reconcileStockAlertScope({
    storeId: finalized.warehouseId == null ? finalized.storeId : null,
    warehouseId: finalized.warehouseId,
    productIds: finalizedItems.map((item) => item.productId),
  });

  res.json({ ...finalized, items: finalizedItems, usageSummary });
});

router.get("/inventory-sessions/:id/items", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const [session] = await db
    .select()
    .from(inventorySessionsTable)
    .where(eq(inventorySessionsTable.id, id));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const user = getUser(req);
  if (!canAccessStore(user, session.storeId)) {
    res.status(403).json({ error: "Access denied to this store's sessions" });
    return;
  }

  const items = await db
    .select()
    .from(inventorySessionItemsTable)
    .where(eq(inventorySessionItemsTable.sessionId, id));

  res.json(items);
});

router.put("/inventory-sessions/:id/items", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const [session] = await db
    .select()
    .from(inventorySessionsTable)
    .where(eq(inventorySessionsTable.id, id));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const user = getUser(req);
  if (!canAccessStore(user, session.storeId)) {
    res.status(403).json({ error: "Access denied to this store's sessions" });
    return;
  }

  if (session.status === "finalized") {
    res.status(400).json({ error: "Cannot modify a finalized session" });
    return;
  }

  const { items } = req.body as {
    items?: Array<{
      productId: number;
      fullContainers: number;
      partialContainers: number;
      estimatedPercentage?: string;
      estimatedGallons?: string;
      comments?: string;
      photoUrls?: string[];
      voiceNoteUrl?: string;
    }>;
  };

  if (!Array.isArray(items)) {
    res.status(400).json({ error: "items must be an array" });
    return;
  }

  // Validate estimatedGallons on every item before touching the DB
  for (const item of items) {
    if (item.estimatedGallons !== undefined && item.estimatedGallons !== null) {
      if (!isValidNonNegativeDecimal(item.estimatedGallons)) {
        res.status(400).json({
          error: `estimatedGallons must be a valid non-negative decimal, got: "${item.estimatedGallons}"`,
        });
        return;
      }
    }
  }

  const results = [];
  for (const item of items) {
    // Check if item already exists
    const [existing] = await db
      .select()
      .from(inventorySessionItemsTable)
      .where(
        and(
          eq(inventorySessionItemsTable.sessionId, id),
          eq(inventorySessionItemsTable.productId, item.productId),
        ),
      );

    if (existing) {
      const [updated] = await db
        .update(inventorySessionItemsTable)
        .set({
          fullContainers: item.fullContainers,
          partialContainers: item.partialContainers,
          estimatedPercentage: item.estimatedPercentage,
          estimatedGallons: item.estimatedGallons,
          comments: item.comments,
          photoUrls: item.photoUrls,
          voiceNoteUrl: item.voiceNoteUrl,
        })
        .where(eq(inventorySessionItemsTable.id, existing.id))
        .returning();
      results.push(updated);
    } else {
      const [created] = await db
        .insert(inventorySessionItemsTable)
        .values({
          sessionId: id,
          productId: item.productId,
          fullContainers: item.fullContainers,
          partialContainers: item.partialContainers,
          estimatedPercentage: item.estimatedPercentage,
          estimatedGallons: item.estimatedGallons,
          comments: item.comments,
          photoUrls: item.photoUrls,
          voiceNoteUrl: item.voiceNoteUrl,
        })
        .returning();
      results.push(created);
    }
  }

  await logAudit(req, "UPDATE_INVENTORY_ITEMS", "inventory_session", id, null, { count: results.length });
  res.json(results);
});

// ---------------------------------------------------------------------------
// PUT /inventory-sessions/:id/items/admin-edit  (admin only — works on finalized)
// ---------------------------------------------------------------------------

router.put("/inventory-sessions/:id/items/admin-edit", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const [session] = await db
    .select()
    .from(inventorySessionsTable)
    .where(eq(inventorySessionsTable.id, id));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const { items } = req.body as {
    items?: Array<{
      productId: number;
      fullContainers: number;
      partialContainers: number;
      estimatedPercentage?: string;
      estimatedGallons?: string;
      comments?: string;
    }>;
  };

  if (!Array.isArray(items)) {
    res.status(400).json({ error: "items must be an array" });
    return;
  }

  // Validate estimatedGallons on every item before touching the DB
  for (const item of items) {
    if (item.estimatedGallons !== undefined && item.estimatedGallons !== null) {
      if (!isValidNonNegativeDecimal(item.estimatedGallons)) {
        res.status(400).json({
          error: `estimatedGallons must be a valid non-negative decimal, got: "${item.estimatedGallons}"`,
        });
        return;
      }
    }
  }

  const results = [];
  for (const item of items) {
    const [existing] = await db
      .select()
      .from(inventorySessionItemsTable)
      .where(
        and(
          eq(inventorySessionItemsTable.sessionId, id),
          eq(inventorySessionItemsTable.productId, item.productId),
        ),
      );

    if (existing) {
      const [updated] = await db
        .update(inventorySessionItemsTable)
        .set({
          fullContainers: item.fullContainers,
          partialContainers: item.partialContainers,
          estimatedPercentage: item.estimatedPercentage,
          estimatedGallons: item.estimatedGallons,
          comments: item.comments,
        })
        .where(eq(inventorySessionItemsTable.id, existing.id))
        .returning();
      results.push(updated);
    } else {
      const [created] = await db
        .insert(inventorySessionItemsTable)
        .values({
          sessionId: id,
          productId: item.productId,
          fullContainers: item.fullContainers,
          partialContainers: item.partialContainers,
          estimatedPercentage: item.estimatedPercentage,
          estimatedGallons: item.estimatedGallons,
          comments: item.comments,
        })
        .returning();
      results.push(created);
    }
  }

  await logAudit(req, "ADMIN_EDIT_INVENTORY_ITEMS", "inventory_session", id, null, { count: results.length });

  // Return the full session detail (items + previousItems + recomputed usage)
  const updatedItems = await db
    .select()
    .from(inventorySessionItemsTable)
    .where(eq(inventorySessionItemsTable.sessionId, id));

  const [prevSession] = await db
    .select()
    .from(inventorySessionsTable)
    .where(
      and(
        eq(inventorySessionsTable.storeId, session.storeId),
        eq(inventorySessionsTable.status, "finalized"),
        session.warehouseId != null
          ? eq(inventorySessionsTable.warehouseId, session.warehouseId)
          : isNull(inventorySessionsTable.warehouseId),
        sql`${inventorySessionsTable.finalizedAt} < ${session.startedAt}`,
      ),
    )
    .orderBy(desc(inventorySessionsTable.finalizedAt))
    .limit(1);

  const previousItems = prevSession
    ? await db
        .select()
        .from(inventorySessionItemsTable)
        .where(eq(inventorySessionItemsTable.sessionId, prevSession.id))
    : null;

  const usageSummary =
    session.status === "finalized"
      ? await computeUsageSummary(id, session.storeId, session.startedAt, session.finalizedAt, session.warehouseId)
      : null;

  // Persist the recomputed snapshot so that subsequent GET requests reflect the
  // admin's corrections rather than serving the stale pre-edit snapshot.
  if (session.status === "finalized" && usageSummary) {
    await db
      .update(inventorySessionsTable)
      .set({ usageSummarySnapshot: usageSummary })
      .where(eq(inventorySessionsTable.id, id));
  }

  if (session.status === "finalized") {
    await reconcileStockAlertScope({
      storeId: session.warehouseId == null ? session.storeId : null,
      warehouseId: session.warehouseId,
      productIds: updatedItems.map((item) => item.productId),
    });
  }

  res.json({ ...session, items: updatedItems, previousItems, usageSummary });
});

export default router;
