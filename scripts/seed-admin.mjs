#!/usr/bin/env node
/**
 * seed-admin.mjs
 *
 * Creates the first admin user from environment variables if no admin exists.
 * Safe to run on every deploy — it is fully idempotent.
 *
 * Required env vars:
 *   DATABASE_URL  – PostgreSQL connection string
 *   ADMIN_PIN     – numeric PIN the admin will log in with
 *   ADMIN_NAME    – display name for the admin account (default: "Admin")
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run seed:admin
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Resolve bcryptjs from the api-server package (it owns this dep)
// ---------------------------------------------------------------------------
const bcrypt = require(
  path.resolve(__dirname, '../artifacts/api-server/node_modules/bcryptjs'),
);

// ---------------------------------------------------------------------------
// Resolve pg from the @workspace/db package (it owns this dep)
// ---------------------------------------------------------------------------
const { Client } = require(
  path.resolve(__dirname, '../lib/db/node_modules/pg'),
);

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PIN    = process.env.ADMIN_PIN;
const ADMIN_NAME   = (process.env.ADMIN_NAME || 'Admin').trim();

if (!DATABASE_URL) {
  console.error('[seed:admin] ERROR: DATABASE_URL is not set.');
  process.exit(1);
}
if (!ADMIN_PIN) {
  console.error('[seed:admin] ERROR: ADMIN_PIN is not set.');
  process.exit(1);
}
if (!/^\d{4,}$/.test(ADMIN_PIN)) {
  console.error('[seed:admin] ERROR: ADMIN_PIN must be at least 4 digits.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const client = new Client({ connectionString: DATABASE_URL });

try {
  await client.connect();

  // Check for any existing admin
  const { rows: existing } = await client.query(
    `SELECT id, name FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1`,
  );

  if (existing.length > 0) {
    console.log(
      `[seed:admin] Admin account already exists (id=${existing[0].id}, name="${existing[0].name}"). Nothing to do.`,
    );
    process.exit(0);
  }

  // Hash PIN with same cost factor as the API server (bcryptjs default rounds = 10)
  const pinHash = bcrypt.hashSync(ADMIN_PIN, 10);

  const { rows: inserted } = await client.query(
    `INSERT INTO users (name, role, pin_hash, is_active)
     VALUES ($1, 'admin', $2, true)
     RETURNING id, name`,
    [ADMIN_NAME, pinHash],
  );

  console.log(
    `[seed:admin] ✓ Admin account created — id=${inserted[0].id}, name="${inserted[0].name}".`,
  );
  console.log(`[seed:admin] You can now log in with name "${ADMIN_NAME}" and your ADMIN_PIN.`);
} catch (err) {
  console.error('[seed:admin] ERROR:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
