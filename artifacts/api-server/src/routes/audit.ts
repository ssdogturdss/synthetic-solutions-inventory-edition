import { Router, type IRouter } from "express";
import { db, auditLogsTable } from "@workspace/db";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../lib/auth";

const router: IRouter = Router();

router.get("/audit-logs", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { userId, storeId, entityType, startDate, endDate, limit } = req.query as {
    userId?: string;
    storeId?: string;
    entityType?: string;
    startDate?: string;
    endDate?: string;
    limit?: string;
  };

  const conditions = [];

  if (userId) {
    const uid = parseInt(userId, 10);
    if (!isNaN(uid)) conditions.push(eq(auditLogsTable.userId, uid));
  }
  if (storeId) {
    const sid = parseInt(storeId, 10);
    if (!isNaN(sid)) conditions.push(eq(auditLogsTable.storeId, sid));
  }
  if (entityType) {
    conditions.push(eq(auditLogsTable.entityType, entityType));
  }
  if (startDate) {
    conditions.push(gte(auditLogsTable.createdAt, new Date(startDate)));
  }
  if (endDate) {
    conditions.push(lte(auditLogsTable.createdAt, new Date(endDate)));
  }

  let query = db
    .select()
    .from(auditLogsTable)
    .orderBy(desc(auditLogsTable.createdAt));

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  const lim = limit ? parseInt(limit, 10) : 100;
  query = query.limit(isNaN(lim) ? 100 : lim) as typeof query;

  const logs = await query;
  res.json(logs);
});

export default router;
