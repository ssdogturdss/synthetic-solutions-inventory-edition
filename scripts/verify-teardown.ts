/**
 * Verifies that all E2E test data was removed by the teardown step.
 *
 * Run immediately after the seed-test-user.ts cleanup phase.
 * Exits with code 1 and a clear message identifying which tables still
 * have orphaned rows, so a broken WHERE clause or missed FK cascade is
 * caught immediately rather than silently corrupting the next run.
 *
 * Run standalone:
 *   scripts/node_modules/.bin/tsx scripts/verify-teardown.ts
 */
import { eq, inArray, like, or, sql } from 'drizzle-orm';

import { db, pool } from '@workspace/db';
import {
  inventoryAlertStatesTable,
  inventorySessionsTable,
  productsTable,
  receivingRecordsTable,
  storesTable,
  usersTable,
  warehouseTransferItemsTable,
  warehouseTransfersTable,
  warehousesTable,
} from '@workspace/db';

// All E2E stores use the '%-E2E' naming convention (e.g. TST-E2E, USG-E2E).
// No list to maintain — new flows just need a store number ending in '-E2E'.
const E2E_STORE_PATTERN = '%-E2E';
const E2E_USER_NAMES = ['TestAdmin', 'StoreUser1'];

// Vendors used across all e2e flows.  Panel Supplier / Snapshot Supplier
// are cleaned up via the store cascade, but we still verify them here.
const E2E_VENDORS = ['Acme Chemical Co.', 'Panel Supplier', 'Snapshot Supplier'];

async function count(label: string, query: Promise<{ count: number }[]>): Promise<{ label: string; count: number }> {
  const [row] = await query;
  return { label, count: row?.count ?? 0 };
}

async function main() {
  console.log('Verifying teardown — checking for orphaned test rows…\n');

  const checks = await Promise.all([
    count(
      `test stores (storeNumber LIKE '${E2E_STORE_PATTERN}')`,
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(storesTable)
        .where(like(storesTable.storeNumber, E2E_STORE_PATTERN)),
    ),

    count(
      `test users (${E2E_USER_NAMES.join(', ')})`,
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(inArray(usersTable.name, E2E_USER_NAMES)),
    ),

    count(
      "inventory sessions (notes LIKE 'E2E test%')",
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(inventorySessionsTable)
        .where(like(inventorySessionsTable.notes, 'E2E test%')),
    ),

    count(
      `receiving records (vendors: ${E2E_VENDORS.join(', ')})`,
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(receivingRecordsTable)
        .where(
          or(...E2E_VENDORS.map((v) => eq(receivingRecordsTable.vendor, v))),
        ),
    ),

    count(
      "test products (TC-001, PNL-*, RPL-*, DCT-*, SCP-*, WRP-E2E-001)",
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(productsTable)
        .where(
          or(
            eq(productsTable.productNumber, 'TC-001'),
            like(productsTable.productNumber, 'PNL-%'),
            like(productsTable.productNumber, 'RPL-%'),
            like(productsTable.productNumber, 'DCT-%'),
            like(productsTable.productNumber, 'SCP-%'),
            eq(productsTable.productNumber, 'WRP-E2E-001'),
          ),
        ),
    ),

    count(
      "test warehouses (warehouseNumber LIKE 'WH-E2E%')",
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(warehousesTable)
        .where(like(warehousesTable.warehouseNumber, 'WH-E2E%')),
    ),

    count(
      "warehouse-to-store transfers (E2E notes)",
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(warehouseTransfersTable)
        .where(like(warehouseTransfersTable.notes, '%E2E warehouse-to-store transfer%')),
    ),

    count(
      'warehouse transfer items without a transfer header',
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(warehouseTransferItemsTable)
        .where(sql`NOT EXISTS (
          SELECT 1 FROM ${warehouseTransfersTable}
          WHERE ${warehouseTransfersTable.id} = ${warehouseTransferItemsTable.transferId}
        )`),
    ),

    count(
      'inventory alert states without a matching location or product',
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(inventoryAlertStatesTable)
        .where(sql`(
          (
            ${inventoryAlertStatesTable.alertKey} LIKE 'store:%'
            AND (
              NOT EXISTS (
                SELECT 1 FROM ${storesTable}
                WHERE ${storesTable.id}::text =
                  split_part(${inventoryAlertStatesTable.alertKey}, ':', 2)
              )
              OR NOT EXISTS (
                SELECT 1 FROM ${productsTable}
                WHERE ${productsTable.id}::text =
                  split_part(${inventoryAlertStatesTable.alertKey}, ':', 4)
              )
            )
          )
          OR (
            ${inventoryAlertStatesTable.alertKey} LIKE 'warehouse:%'
            AND (
              NOT EXISTS (
                SELECT 1 FROM ${warehousesTable}
                WHERE ${warehousesTable.id}::text =
                  split_part(${inventoryAlertStatesTable.alertKey}, ':', 2)
              )
              OR NOT EXISTS (
                SELECT 1 FROM ${productsTable}
                WHERE ${productsTable.id}::text =
                  split_part(${inventoryAlertStatesTable.alertKey}, ':', 4)
              )
            )
          )
        )`),
    ),
  ]);

  let allClear = true;
  for (const { label, count: n } of checks) {
    if (n === 0) {
      console.log(`  ✅ 0 orphaned rows — ${label}`);
    } else {
      console.error(`  ❌ ${n} orphaned row(s) still present — ${label}`);
      allClear = false;
    }
  }

  if (!allClear) {
    console.error('\nTeardown verification FAILED — orphaned test data remains in the database.');
    process.exit(1);
  }

  console.log('\nTeardown verification passed — database is clean.');
}

main()
  .catch((err) => {
    console.error('\nVerification script error:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => pool.end());
