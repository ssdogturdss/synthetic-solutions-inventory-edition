import {
  pgTable,
  serial,
  text,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aiProviderEnum = pgEnum("ai_provider", ["openai", "grok"]);

export const aiConfigTable = pgTable("ai_config", {
  id: serial("id").primaryKey(),
  provider: aiProviderEnum("provider").notNull().default("openai"),
  systemPrompt: text("system_prompt").notNull().default(
    "You are an expert inventory management assistant specializing in car wash chemical inventory. You help track usage, detect anomalies, forecast purchasing needs, and generate executive-quality reports.",
  ),
  apiKeyEncrypted: text("api_key_encrypted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertAiConfigSchema = createInsertSchema(aiConfigTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAiConfig = z.infer<typeof insertAiConfigSchema>;
export type AiConfig = typeof aiConfigTable.$inferSelect;
