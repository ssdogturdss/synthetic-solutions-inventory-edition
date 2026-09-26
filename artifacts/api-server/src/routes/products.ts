import { Router, type IRouter } from "express";
import { db, productsTable } from "@workspace/db";
import { eq, ilike, isNull, and } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../lib/auth";
import { logAudit } from "../lib/audit";

const router: IRouter = Router();

router.get("/products", requireAuth, async (req, res): Promise<void> => {
  const { categoryId, search, activeOnly } = req.query as {
    categoryId?: string;
    search?: string;
    activeOnly?: string;
  };

  const conditions = [isNull(productsTable.deletedAt)];

  if (categoryId) {
    const catId = parseInt(categoryId, 10);
    if (!isNaN(catId)) {
      conditions.push(eq(productsTable.categoryId, catId));
    }
  }
  if (activeOnly === "true") {
    conditions.push(eq(productsTable.isActive, true));
  }
  if (search) {
    conditions.push(ilike(productsTable.name, `%${search}%`));
  }

  const products = await db
    .select()
    .from(productsTable)
    .where(and(...conditions))
    .orderBy(productsTable.name);

  res.json(products);
});

router.post("/products", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const body = req.body as {
    name?: string;
    productNumber?: string;
    description?: string;
    manufacturer?: string;
    categoryId?: number;
    unit?: string;
    containerSize?: string;
    minLevel?: string;
    maxLevel?: string;
    cost?: string;
    vendor?: string;
    barcode?: string;
    photoUrl?: string;
    safetyNotes?: string;
    mixRatio?: string;
    application?: string;
    storageRequirements?: string;
    hazardClassification?: string;
  };

  if (!body.name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const [product] = await db
    .insert(productsTable)
    .values({
      name: body.name,
      productNumber: body.productNumber,
      description: body.description,
      manufacturer: body.manufacturer,
      categoryId: body.categoryId ?? null,
      unit: body.unit,
      containerSize: body.containerSize,
      minLevel: body.minLevel,
      maxLevel: body.maxLevel,
      cost: body.cost,
      vendor: body.vendor,
      barcode: body.barcode,
      photoUrl: body.photoUrl,
      safetyNotes: body.safetyNotes,
      mixRatio: body.mixRatio,
      application: body.application,
      storageRequirements: body.storageRequirements,
      hazardClassification: body.hazardClassification,
    })
    .returning();

  await logAudit(req, "CREATE_PRODUCT", "product", product.id, null, product);
  res.status(201).json(product);
});

router.get("/products/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product ID" });
    return;
  }

  const [product] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, id));

  if (!product || product.deletedAt) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  res.json(product);
});

router.patch("/products/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, id));

  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const allowed = [
    "name", "productNumber", "description", "manufacturer", "categoryId",
    "unit", "containerSize", "minLevel", "maxLevel", "cost", "vendor",
    "barcode", "photoUrl", "safetyNotes", "mixRatio", "application",
    "storageRequirements", "hazardClassification", "isActive",
  ];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  const [updated] = await db
    .update(productsTable)
    .set(updates as any)
    .where(eq(productsTable.id, id))
    .returning();

  await logAudit(req, "UPDATE_PRODUCT", "product", id, existing, updated);
  res.json(updated);
});

router.delete("/products/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product ID" });
    return;
  }

  const [existing] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, id));

  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  await db
    .update(productsTable)
    .set({ deletedAt: new Date(), isActive: false })
    .where(eq(productsTable.id, id));

  await logAudit(req, "DELETE_PRODUCT", "product", id, null, null);
  res.sendStatus(204);
});

export default router;
