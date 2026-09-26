import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  productNumber: text("product_number"),
  name: text("name").notNull(),
  description: text("description"),
  manufacturer: text("manufacturer"),
  categoryId: integer("category_id"),
  unit: text("unit"),
  containerSize: numeric("container_size", { precision: 10, scale: 3 }),
  minLevel: numeric("min_level", { precision: 10, scale: 3 }),
  maxLevel: numeric("max_level", { precision: 10, scale: 3 }),
  cost: numeric("cost", { precision: 10, scale: 2 }),
  vendor: text("vendor"),
  barcode: text("barcode"),
  photoUrl: text("photo_url"),
  safetyNotes: text("safety_notes"),
  mixRatio: text("mix_ratio"),
  application: text("application"),
  storageRequirements: text("storage_requirements"),
  hazardClassification: text("hazard_classification"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const insertProductSchema = createInsertSchema(productsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof productsTable.$inferSelect;
