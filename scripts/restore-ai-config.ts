/**
 * Restores the AI config row from a snapshot produced by snapshot-ai-config.ts.
 *
 * Usage:
 *   scripts/node_modules/.bin/tsx scripts/restore-ai-config.ts <snapshot-file> <test-row-id>
 *
 *   <test-row-id> is the numeric id returned by the PUT /ai/config call during
 *   the test.  It is used to delete the specific row the test created when no
 *   row existed before the test started, avoiding unqualified deletes.
 *
 * Restoration rules:
 *   - Original had no row → DELETE WHERE id = <test-row-id> (only the test row)
 *   - Original had a row  → UPDATE WHERE id = <original-row-id>, restoring all
 *                           fields (provider, systemPrompt, apiKeyEncrypted)
 */
import { readFileSync } from 'node:fs';
import { db, pool } from '@workspace/db';
import { aiConfigTable } from '@workspace/db';
import { eq } from 'drizzle-orm';

const snapshotFile = process.argv[2];
const testRowId    = Number(process.argv[3]);

try {
  if (!snapshotFile) {
    console.error('Usage: restore-ai-config.ts <snapshot-file> <test-row-id>');
    process.exitCode = 1;
  } else {
    const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as {
      exists: boolean;
      row: { id: number; provider: string; systemPrompt: string; apiKeyEncrypted: string | null } | null;
    };

    if (!snapshot.exists || !snapshot.row) {
      // No row existed before the test.  Delete the specific row the test created.
      if (testRowId && !isNaN(testRowId)) {
        const deleted = await db.delete(aiConfigTable)
          .where(eq(aiConfigTable.id, testRowId))
          .returning({ id: aiConfigTable.id });
        console.log(deleted.length > 0
          ? `Deleted test-created ai_config row id=${testRowId} to restore empty state`
          : `Row id=${testRowId} already gone — nothing to delete`);
      } else {
        console.log('No original row and no test-row-id provided — skipping delete');
      }
    } else {
      const { id, provider, systemPrompt, apiKeyEncrypted } = snapshot.row;
      const updated = await db.update(aiConfigTable)
        .set({ provider: provider as 'openai' | 'grok', systemPrompt, apiKeyEncrypted })
        .where(eq(aiConfigTable.id, id))
        .returning({ id: aiConfigTable.id });

      if (updated.length === 0) {
        // The original row was deleted during the test — re-insert with original values
        await db.insert(aiConfigTable).values({
          provider: provider as 'openai' | 'grok',
          systemPrompt,
          apiKeyEncrypted: apiKeyEncrypted ?? undefined,
        });
        console.log(`Re-inserted original ai_config row (id=${id} was missing)`);
      } else {
        console.log(`Restored ai_config row id=${id} (hasKey=${apiKeyEncrypted != null})`);
      }
    }
  }
} finally {
  await pool.end();
}
