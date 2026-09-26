import { pgTable, serial, integer, text, timestamp, numeric, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const warehouseTransfersTable = pgTable("warehouse_transfers", {
  id: serial("id").primaryKey(),
  transferGroupId: text("transfer_group_id").notNull(),
  sourceWarehouseId: integer("source_warehouse_id").notNull(),
  destinationStoreId: integer("destination_store_id").notNull(),
  employeeId: integer("employee_id").notNull(),
  notes: text("notes"),
  transferredAt: timestamp("transferred_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("warehouse_transfers_group_unique").on(table.transferGroupId)]);

export const warehouseTransferItemsTable = pgTable("warehouse_transfer_items", {
  id: serial("id").primaryKey(),
  transferId: integer("transfer_id").notNull(),
  productId: integer("product_id").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 3 }).notNull(),
  receivingRecordId: integer("receiving_record_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("warehouse_transfer_product_unique").on(table.transferId, table.productId)]);

export const insertWarehouseTransferSchema = createInsertSchema(warehouseTransfersTable).omit({ id: true, createdAt: true });
export type InsertWarehouseTransfer = z.infer<typeof insertWarehouseTransferSchema>;
export type WarehouseTransfer = typeof warehouseTransfersTable.$inferSelect;
export const insertWarehouseTransferItemSchema = createInsertSchema(warehouseTransferItemsTable).omit({ id: true, createdAt: true });
export type InsertWarehouseTransferItem = z.infer<typeof insertWarehouseTransferItemSchema>;
export type WarehouseTransferItem = typeof warehouseTransferItemsTable.$inferSelect;