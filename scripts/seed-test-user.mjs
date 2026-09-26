/**
 * Seeds a test admin user directly into the database.
 * Uses the api-server's database connection to avoid shell interpolation issues with bcrypt hashes.
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);

// Use bcryptjs from api-server
const bcrypt = require('/home/runner/workspace/artifacts/api-server/node_modules/bcryptjs');

// Generate hash
const adminHash = bcrypt.hashSync('1234', 10);
const storeHash = bcrypt.hashSync('5678', 10);

console.log('Admin pin hash generated, length:', adminHash.length);
console.log('Hash starts with:', adminHash.slice(0, 7));

// Write SQL to temp file to avoid shell interpolation issues
import { writeFileSync, unlinkSync } from 'node:fs';

const sql = `
-- Clean up any previous test run
DELETE FROM inventory_session_items WHERE session_id IN (
  SELECT id FROM inventory_sessions WHERE notes LIKE 'E2E test%'
);
DELETE FROM inventory_sessions WHERE notes LIKE 'E2E test%';
DELETE FROM receiving_record_items WHERE receiving_record_id IN (
  SELECT id FROM receiving_records WHERE notes LIKE 'E2E test%' OR vendor = 'Acme Chemical Co.'
);
DELETE FROM receiving_records WHERE notes LIKE 'E2E test%' OR vendor = 'Acme Chemical Co.';
DELETE FROM users WHERE name IN ('TestAdmin', 'StoreUser1');
DELETE FROM stores WHERE store_number = 'TST-001';
DELETE FROM products WHERE product_number = 'TC-001';
DELETE FROM categories WHERE name = 'Test Category';

-- Create test admin
INSERT INTO users (name, role, pin_hash, is_active)
VALUES ('TestAdmin', 'admin', '${adminHash}', true);

-- Create test category
INSERT INTO categories (name, description)
VALUES ('Test Category', 'E2E test category')
RETURNING id;

-- Create test product (needs category)
INSERT INTO products (name, product_number, unit, category_id, is_active)
SELECT 'Test Chemical A', 'TC-001', 'gallon', id, true FROM categories WHERE name = 'Test Category';

SELECT 'Seeded: ' || count(*) || ' admin(s)' as result FROM users WHERE name = 'TestAdmin';
SELECT 'Seeded: ' || count(*) || ' product(s)' as result FROM products WHERE product_number = 'TC-001';
`;

writeFileSync('/tmp/seed-e2e.sql', sql);
console.log('SQL file written to /tmp/seed-e2e.sql');

try {
  const out = execSync('psql "$DATABASE_URL" -f /tmp/seed-e2e.sql', { encoding: 'utf8' });
  console.log('Seed output:\n', out);
} catch (e) {
  console.error('Seed error:', e.stdout, e.stderr);
  process.exit(1);
} finally {
  try { unlinkSync('/tmp/seed-e2e.sql'); } catch {}
}

console.log('Seed complete.');
