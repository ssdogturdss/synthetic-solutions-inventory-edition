import { Router, type IRouter } from "express";
import { db, categoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../lib/auth";
import { logAudit } from "../lib/audit";

const router: IRouter = Router();

router.get("/categories", requireAuth, async (_req, res): Promise<void> => {
  const cats = await db
    .select()
    .from(categoriesTable)
    .orderBy(categoriesTable.name);
  res.json(cats);
});

router.post("/categories", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const [cat] = await db
    .insert(categoriesTable)
    .values({ name, description })
    .returning();

  await logAudit(req, "CREATE_CATEGORY", "category", cat.id, null, cat);
  res.status(201).json(cat);
});

router.get("/categories/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid category ID" });
    return;
  }

  const [cat] = await db
    .select()
    .from(categoriesTable)
    .where(eq(categoriesTable.id, id));

  if (!cat) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  res.json(cat);
});

router.patch("/categories/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid category ID" });
    return;
  }

  const { name, description } = req.body as { name?: string; description?: string };
  const updates: Record<string, unknown> = {};
  if (name != null) updates.name = name;
  if (description != null) updates.description = description;

  const [updated] = await db
    .update(categoriesTable)
    .set(updates as any)
    .where(eq(categoriesTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  await logAudit(req, "UPDATE_CATEGORY", "category", id, null, updated);
  res.json(updated);
});

router.delete("/categories/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid category ID" });
    return;
  }

  const [deleted] = await db
    .delete(categoriesTable)
    .where(eq(categoriesTable.id, id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  await logAudit(req, "DELETE_CATEGORY", "category", id, null, null);
  res.sendStatus(204);
});

export default router;
