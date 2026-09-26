import {
  pgEnum,
  pgTable,
  serial,
  integer,
  numeric,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const warehouseMovementTypeEnum = pgEnum("warehouse_movement_type", [
  "receipt",
  "transfer",
  "adjustment",
]);

/**
 * Signed warehouse stock ledger.
 *
 * A transfer is represented by two rows sharing transferGroupId: a negative
 * row at the source and a positive row at the destination. Keeping the ledger
 * append-only makes stock queries auditable and leaves existing store-scoped
 * inventory records untouched.
 */
export const warehouseInventoryMovementsTable = pgTable("warehouse_inventory_movements", {
  id: serial("id").primaryKey(),
  warehouseId: integer("warehouse_id").notNull(),
  productId: integer("product_id").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 3 }).notNull(),
  movementType: warehouseMovementTypeEnum("movement_type").notNull(),
  transferGroupId: text("transfer_group_id"),
  fromWarehouseId: integer("from_warehouse_id"),
  toWarehouseId: integer("to_warehouse_id"),
  destinationStoreId: integer("destination_store_id"),
  receivingRecordId: integer("receiving_record_id"),
  employeeId: integer("employee_id").notNull(),
  notes: text("notes"),
  movedAt: timestamp("moved_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertWarehouseInventoryMovementSchema = createInsertSchema(
  warehouseInventoryMovementsTable,
).omit({ id: true, createdAt: true });
export type InsertWarehouseInventoryMovement = z.infer<
  typeof insertWarehouseInventoryMovementSchema
>;
export type WarehouseInventoryMovement =
  typeof warehouseInventoryMovementsTable.$inferSelect;