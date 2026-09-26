import { Router, type IRouter } from "express";
import { db, chemicalUsageTable } from "@workspace/db";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { requireAuth, getUser, canAccessStore, resolveStoreScope } from "../lib/auth";
import { logAudit } from "../lib/audit";

const router: IRouter = Router();

router.get("/chemical-usage", requireAuth, async (req, res): Promise<void> => {
  const { storeId, status, startDate, endDate } = req.query as {
    storeId?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
  };

  const user = getUser(req);
  const { storeId: scopedStoreId, denied } = resolveStoreScope(user, res);
  if (denied) return;

  const conditions = [];

  if (scopedStoreId !== null) {
    conditions.push(eq(chemicalUsageTable.storeId, scopedStoreId));
  } else if (storeId) {
    const sid = parseInt(storeId, 10);
    if (!isNaN(sid)) conditions.push(eq(chemicalUsageTable.storeId, sid));
  }

  if (status === "active" || status === "consumed" || status === "returned") {
    conditions.push(eq(chemicalUsageTable.status, status));
  }
  if (startDate) {
    conditions.push(gte(chemicalUsageTable.pulledAt, new Date(startDate)));
  }
  if (endDate) {
    conditions.push(lte(chemicalUsageTable.pulledAt, new Date(endDate)));
  }

  let query = db
    .select()
    .from(chemicalUsageTable)
    .orderBy(desc(chemicalUsageTable.pulledAt));

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  const entries = await query;
  res.json(entries);
});

router.post("/chemical-usage", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  const body = req.body as {
    storeId?: number;
    productId?: number;
    amountPulled?: string;
    reason?: string;
    equipment?: string;
    vehicleTunnel?: string;
    location?: string;
    comments?: string;
  };

  if (!body.storeId || !body.productId || !body.amountPulled) {
    res.status(400).json({ error: "storeId, productId, and amountPulled are required" });
    return;
  }

  if (!canAccessStore(user, body.storeId)) {
    res.status(403).json({ error: "Access denied to this store" });
    return;
  }

  const [entry] = await db
    .insert(chemicalUsageTable)
    .values({
      storeId: body.storeId,
      employeeId: user.userId,
      productId: body.productId,
      amountPulled: body.amountPulled,
      reason: body.reason,
      equipment: body.equipment,
      vehicleTunnel: body.vehicleTunnel,
      location: body.location,
      comments: body.comments,
    })
    .returning();

  await logAudit(req, "CREATE_CHEMICAL_USAGE", "chemical_usage", entry.id, null, entry);
  res.status(201).json(entry);
});

router.patch("/chemical-usage/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid usage ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(chemicalUsageTable)
    .where(eq(chemicalUsageTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Chemical usage entry not found" });
    return;
  }

  const user = getUser(req);
  if (!canAccessStore(user, existing.storeId)) {
    res.status(403).json({ error: "Access denied to this store's records" });
    return;
  }

  const { status, comments } = req.body as {
    status?: string;
    comments?: string;
  };

  if (!status || !["active", "consumed", "returned"].includes(status)) {
    res.status(400).json({ error: "status must be active, consumed, or returned" });
    return;
  }

  const updates: Record<string, unknown> = {
    status,
  };
  if (comments != null) updates.comments = comments;
  if (status === "consumed" || status === "returned") {
    updates.resolvedAt = new Date();
  }

  const [updated] = await db
    .update(chemicalUsageTable)
    .set(updates as any)
    .where(eq(chemicalUsageTable.id, id))
    .returning();

  await logAudit(req, "UPDATE_CHEMICAL_USAGE", "chemical_usage", id, existing, updated);
  res.json(updated);
});

export default router;
