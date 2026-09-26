import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Request, Response, NextFunction } from "express";

function getJwtSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "FATAL: SESSION_SECRET must be set and contain at least 32 characters. Refusing to start.",
    );
  }
  return secret;
}
const JWT_SECRET = getJwtSecret();
const TOKEN_EXPIRY = "8h";

export interface TokenPayload {
  userId: number;
  role: "admin" | "store_user";
  storeId: number | null;
}

export function hashPin(pin: string): string {
  return bcrypt.hashSync(pin, 10);
}

export function verifyPin(pin: string, hash: string): boolean {
  return bcrypt.compareSync(pin, hash);
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

export interface KioskTokenPayload {
  type: "kiosk";
  storeId: number;
}

const KIOSK_TOKEN_EXPIRY = "30d";

export function signKioskToken(storeId: number): string {
  const payload: KioskTokenPayload = { type: "kiosk", storeId };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: KIOSK_TOKEN_EXPIRY });
}

export function verifyKioskToken(token: string): KioskTokenPayload {
  const payload = jwt.verify(token, JWT_SECRET) as KioskTokenPayload;
  if (payload.type !== "kiosk") {
    throw new Error("Not a kiosk token");
  }
  return payload;
}

export function requireKioskAuth(req: Request, res: Response, next: NextFunction): void {
  // Accept token from Authorization header or ?token= query param
  let token: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (typeof req.query.token === "string") {
    token = req.query.token;
  }
  if (!token) {
    res.status(401).json({ error: "Missing kiosk token" });
    return;
  }
  try {
    const payload = verifyKioskToken(token);
    (req as Request & { kiosk: KioskTokenPayload }).kiosk = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired kiosk token" });
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authorization token" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);
    (req as Request & { user: TokenPayload }).user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: TokenPayload }).user;
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (user.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

export function getUser(req: Request): TokenPayload {
  return (req as Request & { user: TokenPayload }).user;
}

/**
 * Returns true if the authenticated user is allowed to access the given storeId.
 * Admins can access any store. Store users can only access their own store.
 * Store users without a storeId always return false (fail closed).
 */
export function canAccessStore(user: TokenPayload, targetStoreId: number): boolean {
  if (user.role === "admin") return true;
  if (user.storeId === null) return false; // store_user without assignment — deny
  return user.storeId === targetStoreId;
}

/**
 * For store_user: returns their storeId or throws 403 response.
 * For admin: returns null (no scoping unless caller adds it explicitly).
 * Call this early in list/report endpoints to enforce fail-closed scoping.
 */
export function resolveStoreScope(
  user: TokenPayload,
  res: { status: (c: number) => { json: (b: unknown) => void } },
): { storeId: number | null; denied: boolean } {
  if (user.role === "store_user") {
    if (!user.storeId) {
      res.status(403).json({ error: "Store user account has no assigned store" });
      return { storeId: null, denied: true };
    }
    return { storeId: user.storeId, denied: false };
  }
  return { storeId: null, denied: false }; // admin — no mandatory scope
}
