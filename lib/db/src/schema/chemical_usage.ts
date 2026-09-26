import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const chemicalUsageStatusEnum = pgEnum("chemical_usage_status", [
  "active",
  "consumed",
  "returned",
]);

export const chemicalUsageTable = pgTable("chemical_usage", {
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull(),
  employeeId: integer("employee_id").notNull(),
  productId: integer("product_id").notNull(),
  amountPulled: numeric("amount_pulled", { precision: 10, scale: 3 }).notNull(),
  reason: text("reason"),
  equipment: text("equipment"),
  vehicleTunnel: text("vehicle_tunnel"),
  location: text("location"),
  comments: text("comments"),
  status: chemicalUsageStatusEnum("status").notNull().default("active"),
  pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertChemicalUsageSchema = createInsertSchema(
  chemicalUsageTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertChemicalUsage = z.infer<typeof insertChemicalUsageSchema>;
export type ChemicalUsage = typeof chemicalUsageTable.$inferSelect;
