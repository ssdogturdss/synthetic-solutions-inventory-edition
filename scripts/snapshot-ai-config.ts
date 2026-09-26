/**
 * Snapshots the current AI config row (including the encrypted key blob) to a
 * JSON file WITHOUT decrypting it.  Used by the e2e suite to preserve state
 * before the AI-report flow mutates the config.
 *
 * Usage:
 *   scripts/node_modules/.bin/tsx scripts/snapshot-ai-config.ts <output-file>
 */
import { writeFileSync } from 'node:fs';
import { db, pool } from '@workspace/db';
import { aiConfigTable } from '@workspace/db';

const outFile = process.argv[2];

try {
  if (!outFile) {
    console.error('Usage: snapshot-ai-config.ts <output-file>');
    process.exitCode = 1;
  } else {
    const [row] = await db.select().from(aiConfigTable).limit(1);

    const snapshot = row
      ? { exists: true, row: { id: row.id, provider: row.provider, systemPrompt: row.systemPrompt, apiKeyEncrypted: row.apiKeyEncrypted ?? null } }
      : { exists: false, row: null };

    writeFileSync(outFile, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(row ? `Snapshot saved (hasKey=${row.apiKeyEncrypted != null})` : 'Snapshot saved (no config row)');
  }
} finally {
  await pool.end();
}
