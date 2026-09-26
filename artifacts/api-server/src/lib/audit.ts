import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db";
import { Request } from "express";
import { TokenPayload } from "./auth";

export async function logAudit(
  req: Request,
  action: string,
  entityType?: string,
  entityId?: number,
  oldValues?: unknown,
  newValues?: unknown,
): Promise<void> {
  try {
    const user = (req as Request & { user?: TokenPayload }).user;
    const ip = req.ip ?? req.socket.remoteAddress;
    await db.insert(auditLogsTable).values({
      userId: user?.userId ?? null,
      storeId: user?.storeId ?? null,
      action,
      entityType: entityType ?? null,
      entityId: entityId ?? null,
      oldValues: oldValues ?? null,
      newValues: newValues ?? null,
      ipAddress: ip ?? null,
    });
  } catch {
    // Audit failures must never break the primary operation
  }
}
