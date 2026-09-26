import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import { requireAuth, requireAdmin, hashPin } from "../lib/auth";
import { logAudit } from "../lib/audit";

const router: IRouter = Router();

router.get("/users", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const users = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      storeId: usersTable.storeId,
      biometricEnabled: usersTable.biometricEnabled,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(isNull(usersTable.deletedAt))
    .orderBy(usersTable.name);
  res.json(users);
});

router.post("/users", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const body = req.body as {
    name?: string;
    email?: string;
    role?: string;
    pin?: string;
    storeId?: number;
    biometricEnabled?: boolean;
  };

  if (!body.name || !body.pin || !body.role) {
    res.status(400).json({ error: "name, pin, and role are required" });
    return;
  }
  if (!["admin", "store_user"].includes(body.role)) {
    res.status(400).json({ error: "role must be admin or store_user" });
    return;
  }

  const pinHash = hashPin(body.pin);

  const [user] = await db
    .insert(usersTable)
    .values({
      name: body.name,
      email: body.email,
      role: body.role as "admin" | "store_user",
      pinHash,
      storeId: body.storeId ?? null,
      biometricEnabled: body.biometricEnabled ?? false,
    })
    .returning({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      storeId: usersTable.storeId,
      biometricEnabled: usersTable.biometricEnabled,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    });

  await logAudit(req, "CREATE_USER", "user", user.id, null, { ...user });
  res.status(201).json(user);
});

router.get("/users/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  const [user] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      storeId: usersTable.storeId,
      biometricEnabled: usersTable.biometricEnabled,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, id));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(user);
});

router.patch("/users/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, id));

  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const body = req.body as {
    name?: string;
    email?: string;
    role?: string;
    storeId?: number | null;
    biometricEnabled?: boolean;
    isActive?: boolean;
  };

  const updates: Record<string, unknown> = {};
  if (body.name != null) updates.name = body.name;
  if (body.email != null) updates.email = body.email;
  if (body.role != null) updates.role = body.role;
  if ("storeId" in body) updates.storeId = body.storeId;
  if (body.biometricEnabled != null) updates.biometricEnabled = body.biometricEnabled;
  if (body.isActive != null) updates.isActive = body.isActive;

  const [updated] = await db
    .update(usersTable)
    .set(updates as any)
    .where(eq(usersTable.id, id))
    .returning({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      storeId: usersTable.storeId,
      biometricEnabled: usersTable.biometricEnabled,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    });

  await logAudit(req, "UPDATE_USER", "user", id, {}, updated);
  res.json(updated);
});

router.delete("/users/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, id));

  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  await db
    .update(usersTable)
    .set({ deletedAt: new Date(), isActive: false })
    .where(eq(usersTable.id, id));

  await logAudit(req, "DELETE_USER", "user", id, null, null);
  res.sendStatus(204);
});

router.post("/users/:id/reset-pin", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  const { newPin } = req.body as { newPin?: string };
  if (!newPin || newPin.length < 4) {
    res.status(400).json({ error: "newPin must be at least 4 digits" });
    return;
  }

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, id));

  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const pinHash = hashPin(newPin);
  await db
    .update(usersTable)
    .set({ pinHash })
    .where(eq(usersTable.id, id));

  await logAudit(req, "RESET_PIN", "user", id, null, null);
  res.json({ message: "PIN reset successfully" });
});

export default router;
