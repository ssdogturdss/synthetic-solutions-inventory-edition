import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, or } from "drizzle-orm";
import { requireAuth, hashPin, verifyPin, signToken, getUser } from "../lib/auth";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const { pin, userId, name } = req.body as {
    pin?: string;
    userId?: number;
    name?: string;
  };

  if (!pin) {
    res.status(400).json({ error: "PIN is required" });
    return;
  }

  // Find user by id or name
  let user;
  if (userId) {
    [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
  } else if (name) {
    [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.name, name));
  } else {
    res.status(400).json({ error: "Provide userId or name" });
    return;
  }

  if (!user || !user.isActive) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = verifyPin(pin, user.pinHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = signToken({
    userId: user.id,
    role: user.role,
    storeId: user.storeId,
  });

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      storeId: user.storeId,
      biometricEnabled: user.biometricEnabled,
      isActive: user.isActive,
      createdAt: user.createdAt,
    },
  });
});

router.post("/auth/logout", requireAuth, (_req, res): void => {
  // JWT is stateless — client drops the token
  res.json({ message: "Logged out" });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const payload = getUser(req);
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, payload.userId));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    storeId: user.storeId,
    biometricEnabled: user.biometricEnabled,
    isActive: user.isActive,
    createdAt: user.createdAt,
  });
});

export default router;
