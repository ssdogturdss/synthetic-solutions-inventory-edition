import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
  pgEnum,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const inventorySessionStatusEnum = pgEnum(
  "inventory_session_status",
  ["open", "finalized"],
);

export const inventorySessionsTable = pgTable("inventory_sessions", {
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull(),
  warehouseId: integer("warehouse_id"),
  employeeId: integer("employee_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  status: inventorySessionStatusEnum("status").notNull().default("open"),
  notes: text("notes"),
  usageSummarySnapshot: jsonb("usage_summary_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const inventorySessionItemsTable = pgTable("inventory_session_items", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  productId: integer("product_id").notNull(),
  fullContainers: integer("full_containers").notNull().default(0),
  partialContainers: integer("partial_containers").notNull().default(0),
  estimatedPercentage: numeric("estimated_percentage", { precision: 5, scale: 2 }),
  estimatedGallons: numeric("estimated_gallons", { precision: 10, scale: 3 }),
  comments: text("comments"),
  photoUrls: text("photo_urls").array(),
  voiceNoteUrl: text("voice_note_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertInventorySessionSchema = createInsertSchema(
  inventorySessionsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInventorySession = z.infer<typeof insertInventorySessionSchema>;
export type InventorySession = typeof inventorySessionsTable.$inferSelect;

export const insertInventorySessionItemSchema = createInsertSchema(
  inventorySessionItemsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInventorySessionItem = z.infer<
  typeof insertInventorySessionItemSchema
>;
export type InventorySessionItem = typeof inventorySessionItemsTable.$inferSelect;
