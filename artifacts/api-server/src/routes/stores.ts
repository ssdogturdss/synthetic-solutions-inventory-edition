import { Router, type IRouter } from "express";
import { db, storesTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import { requireAuth, requireAdmin, signKioskToken } from "../lib/auth";
import { logAudit } from "../lib/audit";

const router: IRouter = Router();

router.get("/stores", requireAuth, async (req, res): Promise<void> => {
  const stores = await db
    .select()
    .from(storesTable)
    .where(isNull(storesTable.deletedAt))
    .orderBy(storesTable.name);
  res.json(stores);
});

router.post("/stores", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const body = req.body as {
    name?: string;
    storeNumber?: string;
    manager?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    phone?: string;
    email?: string;
    region?: string;
    district?: string;
    status?: string;
    latitude?: string;
    longitude?: string;
    inventorySchedule?: string;
    notes?: string;
  };

  if (!body.name || !body.storeNumber) {
    res.status(400).json({ error: "name and storeNumber are required" });
    return;
  }

  const [store] = await db
    .insert(storesTable)
    .values({
      name: body.name,
      storeNumber: body.storeNumber,
      manager: body.manager,
      address: body.address,
      city: body.city,
      state: body.state,
      zip: body.zip,
      phone: body.phone,
      email: body.email,
      region: body.region,
      district: body.district,
      status: (body.status as "active" | "inactive" | "disabled") ?? "active",
      latitude: body.latitude,
      longitude: body.longitude,
      inventorySchedule: body.inventorySchedule,
      notes: body.notes,
    })
    .returning();

  await logAudit(req, "CREATE_STORE", "store", store.id, null, store);
  res.status(201).json(store);
});

router.get("/stores/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid store ID" });
    return;
  }

  const [store] = await db
    .select()
    .from(storesTable)
    .where(eq(storesTable.id, id));

  if (!store || store.deletedAt) {
    res.status(404).json({ error: "Store not found" });
    return;
  }

  res.json(store);
});

router.patch("/stores/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid store ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(storesTable)
    .where(eq(storesTable.id, id));

  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "Store not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const allowed = [
    "name", "storeNumber", "manager", "address", "city", "state", "zip",
    "phone", "email", "region", "district", "status", "latitude", "longitude",
    "inventorySchedule", "notes", "isActive",
  ];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  const [updated] = await db
    .update(storesTable)
    .set(updates as any)
    .where(eq(storesTable.id, id))
    .returning();

  await logAudit(req, "UPDATE_STORE", "store", id, existing, updated);
  res.json(updated);
});

router.post("/stores/:id/kiosk-token", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid store ID" });
    return;
  }

  const [store] = await db
    .select()
    .from(storesTable)
    .where(eq(storesTable.id, id));

  if (!store || store.deletedAt) {
    res.status(404).json({ error: "Store not found" });
    return;
  }

  const token = signKioskToken(id);
  await logAudit(req, "CREATE_KIOSK_TOKEN", "store", id, null, { storeId: id });
  res.json({ token, storeId: id, expiresIn: "30d" });
});

router.delete("/stores/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid store ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(storesTable)
    .where(eq(storesTable.id, id));

  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "Store not found" });
    return;
  }

  // Soft delete
  await db
    .update(storesTable)
    .set({ deletedAt: new Date(), isActive: false })
    .where(eq(storesTable.id, id));

  await logAudit(req, "DELETE_STORE", "store", id, existing, null);
  res.sendStatus(204);
});

export default router;
