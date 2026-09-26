import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const notificationPlatformEnum = pgEnum("notification_platform", [
  "expo",
  "web",
]);

export const notificationCategoryEnum = pgEnum("notification_category", [
  "backup",
  "inventory",
]);

export const notificationDeliveryStatusEnum = pgEnum("notification_delivery_status", [
  "pending",
  "sent",
  "failed",
]);

export const pushDevicesTable = pgTable(
  "push_devices",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    platform: notificationPlatformEnum("platform").notNull(),
    registrationKey: text("registration_key").notNull(),
    subscription: jsonb("subscription").notNull(),
    backupEnabled: boolean("backup_enabled").notNull().default(false),
    inventoryEnabled: boolean("inventory_enabled").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("push_devices_registration_key_unique").on(table.registrationKey),
    index("push_devices_user_active_idx").on(table.userId, table.isActive),
  ],
);

export const pushOutboxTable = pgTable(
  "push_outbox",
  {
    id: serial("id").primaryKey(),
    dedupeKey: text("dedupe_key").notNull(),
    deviceId: integer("device_id")
      .notNull()
      .references(() => pushDevicesTable.id, { onDelete: "cascade" }),
    category: notificationCategoryEnum("category").notNull(),
    scopeStoreId: integer("scope_store_id"),
    scopeWarehouseId: integer("scope_warehouse_id"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    route: text("route").notNull(),
    status: notificationDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("push_outbox_dedupe_key_unique").on(table.dedupeKey),
    index("push_outbox_pending_idx").on(table.status, table.nextAttemptAt),
  ],
);

export const inventoryAlertStatesTable = pgTable("inventory_alert_states", {
  alertKey: text("alert_key").primaryKey(),
  isActive: boolean("is_active").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const backupAlertStatesTable = pgTable("backup_alert_states", {
  alertKey: text("alert_key").primaryKey(),
  isActive: boolean("is_active").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});