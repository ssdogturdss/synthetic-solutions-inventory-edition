import { Router, type IRouter } from "express";
import { GetBackupHealthResponse } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../lib/auth";
import { getBackupHealth } from "../lib/backup-health";

const router: IRouter = Router();

router.get("/backup/health", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const health = await getBackupHealth();
  res.json(GetBackupHealthResponse.parse(health));
});

export default router;