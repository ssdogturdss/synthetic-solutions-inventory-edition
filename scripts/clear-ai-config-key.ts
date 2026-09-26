/**
 * Clears the stored API key for a specific AI config row.
 * Used by the e2e suite to set up the "no key configured" 503 test scenario.
 * Operates on the row by ID to avoid touching unrelated rows.
 *
 * Usage:
 *   scripts/node_modules/.bin/tsx scripts/clear-ai-config-key.ts <row-id>
 */
import { db, pool } from '@workspace/db';
import { aiConfigTable } from '@workspace/db';
import { eq } from 'drizzle-orm';

const rowId = Number(process.argv[2]);
if (!rowId || isNaN(rowId)) {
  console.error('Usage: clear-ai-config-key.ts <row-id>');
  process.exit(1);
}

const updated = await db.update(aiConfigTable)
  .set({ apiKeyEncrypted: null })
  .where(eq(aiConfigTable.id, rowId))
  .returning({ id: aiConfigTable.id });

if (updated.length === 0) {
  console.error(`No ai_config row found with id=${rowId}`);
  process.exit(1);
}

console.log(`AI config key cleared for row id=${rowId}`);
await pool.end();
