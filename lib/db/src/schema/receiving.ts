import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
  date,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const receivingRecordsTable = pgTable("receiving_records", {
  id: serial("id").primaryKey(),
  // Legacy store receipts remain supported; warehouse-only receipts leave this null.
  storeId: integer("store_id"),
  warehouseId: integer("warehouse_id"),
  employeeId: integer("employee_id").notNull(),
  vendor: text("vendor"),
  invoiceNumber: text("invoice_number"),
  poNumber: text("po_number"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
  photoUrls: text("photo_urls").array(),
  signatureUrl: text("signature_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const receivingRecordItemsTable = pgTable("receiving_record_items", {
  id: serial("id").primaryKey(),
  receivingRecordId: integer("receiving_record_id").notNull(),
  productId: integer("product_id").notNull(),
  quantityReceived: numeric("quantity_received", { precision: 10, scale: 3 }).notNull(),
  lotNumber: text("lot_number"),
  cost: numeric("cost", { precision: 10, scale: 2 }),
  expirationDate: date("expiration_date", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertReceivingRecordSchema = createInsertSchema(
  receivingRecordsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertReceivingRecord = z.infer<typeof insertReceivingRecordSchema>;
export type ReceivingRecord = typeof receivingRecordsTable.$inferSelect;

export const insertReceivingRecordItemSchema = createInsertSchema(
  receivingRecordItemsTable,
).omit({ id: true, createdAt: true });
export type InsertReceivingRecordItem = z.infer<
  typeof insertReceivingRecordItemSchema
>;
export type ReceivingRecordItem = typeof receivingRecordItemsTable.$inferSelect;
