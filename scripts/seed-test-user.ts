/**
 * Seeds test data (admin user, category, product) using the shared Drizzle ORM layer.
 *
 * Run standalone:
 *   scripts/node_modules/.bin/tsx scripts/seed-test-user.ts
 *
 * Each operation is labelled so failures surface with the step name rather than
 * a cryptic SQL or psql error.
 */
import bcrypt from 'bcryptjs';
import { eq, inArray, like, or, sql } from 'drizzle-orm';

import { db, pool } from '@workspace/db';
import {
  categoriesTable,
  inventoryAlertStatesTable,
  inventorySessionItemsTable,
  inventorySessionsTable,
  productsTable,
  receivingRecordItemsTable,
  receivingRecordsTable,
  storesTable,
  usersTable,
  warehouseInventoryMovementsTable,
  warehouseTransferItemsTable,
  warehouseTransfersTable,
  warehousesTable,
} from '@workspace/db';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    console.log(`  ✅ ${name}`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ ${name} failed: ${message}`);
    throw new Error(`Seed step "${name}" failed: ${message}`, { cause: err });
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Seeding test data…\n');

  await step('Delete inventory alert states with removed targets', () =>
    db.delete(inventoryAlertStatesTable).where(sql`(
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
  );

  // ── 1. Clean up any prior test run ────────────────────────────────────────

  const testSessions = await step('Find E2E inventory sessions', () =>
    db
      .select({ id: inventorySessionsTable.id })
      .from(inventorySessionsTable)
      .where(like(inventorySessionsTable.notes, 'E2E test%')),
  );

  if (testSessions.length > 0) {
    const sessionIds = testSessions.map((s) => s.id);
    await step('Delete inventory session items', () =>
      db
        .delete(inventorySessionItemsTable)
        .where(inArray(inventorySessionItemsTable.sessionId, sessionIds)),
    );
  }

  await step('Delete E2E inventory sessions', () =>
    db
      .delete(inventorySessionsTable)
      .where(like(inventorySessionsTable.notes, 'E2E test%')),
  );

  const e2eTransfers = await step('Find E2E warehouse-to-store transfers', () =>
    db
      .select({ id: warehouseTransfersTable.id })
      .from(warehouseTransfersTable)
      .where(like(warehouseTransfersTable.notes, '%E2E warehouse-to-store transfer%')),
  );
  if (e2eTransfers.length > 0) {
    const transferIds = e2eTransfers.map((transfer) => transfer.id);
    await step('Delete E2E warehouse transfer items', () =>
      db
        .delete(warehouseTransferItemsTable)
        .where(inArray(warehouseTransferItemsTable.transferId, transferIds)),
    );
    await step('Delete E2E warehouse transfers', () =>
      db
        .delete(warehouseTransfersTable)
        .where(inArray(warehouseTransfersTable.id, transferIds)),
    );
  }

  // Clean up warehouse E2E rows after movements have been removed. Warehouse
  // deletion is soft in the API, so this hard cleanup is required to keep
  // repeated runs deterministic.
  const testWarehouses = await step('Find E2E warehouses', () =>
    db
      .select({ id: warehousesTable.id })
      .from(warehousesTable)
      .where(like(warehousesTable.warehouseNumber, 'WH-E2E%')),
  );

  if (testWarehouses.length > 0) {
    const warehouseIds = testWarehouses.map((warehouse) => warehouse.id);
    await step('Delete inventory alert states for E2E warehouses', () =>
      db
        .delete(inventoryAlertStatesTable)
        .where(
          or(
            ...warehouseIds.map((id) =>
              like(inventoryAlertStatesTable.alertKey, `warehouse:${id}:product:%`),
            ),
          ),
        ),
    );
    await step('Delete E2E warehouse movements', () =>
      db
        .delete(warehouseInventoryMovementsTable)
        .where(
          or(
            inArray(warehouseInventoryMovementsTable.warehouseId, warehouseIds),
            inArray(warehouseInventoryMovementsTable.fromWarehouseId, warehouseIds),
            inArray(warehouseInventoryMovementsTable.toWarehouseId, warehouseIds),
          ),
        ),
    );
    await step('Delete E2E warehouses', () =>
      db
        .delete(warehousesTable)
        .where(inArray(warehousesTable.id, warehouseIds)),
    );
  }

  const testReceiving = await step('Find E2E receiving records', () =>
    db
      .select({ id: receivingRecordsTable.id })
      .from(receivingRecordsTable)
      .where(
        or(
          like(receivingRecordsTable.notes, 'E2E test%'),
          eq(receivingRecordsTable.vendor, 'Acme Chemical Co.'),
        ),
      ),
  );

  if (testReceiving.length > 0) {
    const recordIds = testReceiving.map((r) => r.id);
    await step('Delete receiving record items', () =>
      db
        .delete(receivingRecordItemsTable)
        .where(inArray(receivingRecordItemsTable.receivingRecordId, recordIds)),
    );
  }

  await step('Delete E2E receiving records', () =>
    db
      .delete(receivingRecordsTable)
      .where(
        or(
          like(receivingRecordsTable.notes, 'E2E test%'),
          eq(receivingRecordsTable.vendor, 'Acme Chemical Co.'),
        ),
      ),
  );

  // Clean up test stores (and their dependent sessions/records/users).
  // All E2E stores follow the '%-E2E' naming convention (e.g. TST-E2E, USG-E2E)
  // so no list needs to be maintained — any future flow just needs to use a
  // store number ending in '-E2E'.
  const testStores = await step('Find E2E test stores', () =>
    db
      .select({ id: storesTable.id })
      .from(storesTable)
      .where(like(storesTable.storeNumber, '%-E2E')),
  );

  if (testStores.length > 0) {
    const storeIds = testStores.map((s) => s.id);
    await step('Delete inventory alert states for E2E stores', () =>
      db
        .delete(inventoryAlertStatesTable)
        .where(
          or(
            ...storeIds.map((id) =>
              like(inventoryAlertStatesTable.alertKey, `store:${id}:product:%`),
            ),
          ),
        ),
    );

    const storeSessions = await step('Find sessions in test stores', () =>
      db
        .select({ id: inventorySessionsTable.id })
        .from(inventorySessionsTable)
        .where(inArray(inventorySessionsTable.storeId, storeIds)),
    );
    if (storeSessions.length > 0) {
      await step('Delete session items for test stores', () =>
        db
          .delete(inventorySessionItemsTable)
          .where(inArray(inventorySessionItemsTable.sessionId, storeSessions.map((s) => s.id))),
      );
    }
    await step('Delete sessions for test stores', () =>
      db.delete(inventorySessionsTable).where(inArray(inventorySessionsTable.storeId, storeIds)),
    );

    const storeRecords = await step('Find receiving records in test stores', () =>
      db
        .select({ id: receivingRecordsTable.id })
        .from(receivingRecordsTable)
        .where(inArray(receivingRecordsTable.storeId, storeIds)),
    );
    if (storeRecords.length > 0) {
      await step('Delete receiving record items for test stores', () =>
        db
          .delete(receivingRecordItemsTable)
          .where(inArray(receivingRecordItemsTable.receivingRecordId, storeRecords.map((r) => r.id))),
      );
    }
    await step('Delete receiving records for test stores', () =>
      db.delete(receivingRecordsTable).where(inArray(receivingRecordsTable.storeId, storeIds)),
    );

    await step('Delete users assigned to test stores', () =>
      db.delete(usersTable).where(inArray(usersTable.storeId, storeIds)),
    );

    await step('Delete E2E test stores', () =>
      db.delete(storesTable).where(inArray(storesTable.id, storeIds)),
    );
  }

  await step('Delete test users (TestAdmin, StoreUser1)', () =>
    db.delete(usersTable).where(inArray(usersTable.name, ['TestAdmin', 'StoreUser1'])),
  );

  // Delete all e2e-created products. TC-001 is the base seed product;
  // PNL-* are created by the usage-panel flow (Flow 10), RPL-* by the
  // reopen-panel flow (Flow 13), DCT-* by the deactivated-product flow
  // (Flow 14), SCP-* by the scoped streaming chat flow, and WRP-E2E-001 by
  // warehouse report coverage — none of these are attached to a test store so the
  // store-cascade above does not reach them.
  const testProductFilter = or(
    eq(productsTable.productNumber, 'TC-001'),
    like(productsTable.productNumber, 'PNL-%'),
    like(productsTable.productNumber, 'RPL-%'),
    like(productsTable.productNumber, 'DCT-%'),
    like(productsTable.productNumber, 'SCP-%'),
    eq(productsTable.productNumber, 'WRP-E2E-001'),
  );
  if (!testProductFilter) {
    throw new Error('E2E product cleanup filter could not be created');
  }
  const testProducts = await step('Find E2E test products', () =>
    db
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(testProductFilter),
  );
  if (testProducts.length > 0) {
    await step('Delete inventory alert states for E2E products', () =>
      db
        .delete(inventoryAlertStatesTable)
        .where(
          or(
            ...testProducts.map(({ id }) =>
              like(inventoryAlertStatesTable.alertKey, `%:product:${id}:%`),
            ),
          ),
        ),
    );
  }
  await step('Delete test products (TC-001, PNL-*, RPL-*, DCT-*, SCP-*, WRP-E2E-001)', () =>
    db.delete(productsTable).where(testProductFilter),
  );

  await step('Delete test category', () =>
    db.delete(categoriesTable).where(eq(categoriesTable.name, 'Test Category')),
  );

  // Delete test stores last (after all FK-referencing rows are gone).
  // Pattern '%-E2E' covers every store created by e2e-test.mjs without
  // requiring this file to be updated when new flows are added.
  await step('Delete test stores', () =>
    db
      .delete(storesTable)
      .where(like(storesTable.storeNumber, '%-E2E')),
  );

  // ── 2. Seed fresh data (skipped when CLEANUP_ONLY=1) ─────────────────────

  if (process.env['CLEANUP_ONLY'] === '1') {
    console.log('\nCleanup complete (CLEANUP_ONLY mode — skipping seed).');
    return;
  }

  console.log('');

  const adminHash = await step('Hash admin PIN', async () => bcrypt.hashSync('1234', 10));
  const _storeHash = await step('Hash store user PIN', async () => bcrypt.hashSync('5678', 10));

  await step('Create TestAdmin user', () =>
    db.insert(usersTable).values({
      name: 'TestAdmin',
      role: 'admin',
      pinHash: adminHash,
      isActive: true,
    }),
  );

  const inserted = await step('Create test category', () =>
    db
      .insert(categoriesTable)
      .values({ name: 'Test Category', description: 'E2E test category' })
      .returning({ id: categoriesTable.id }),
  );

  const category = inserted[0];
  if (!category) {
    throw new Error(
      'Seed step "Create test category" returned no rows — the insert was silently skipped',
    );
  }

  await step('Create test product (TC-001)', () =>
    db.insert(productsTable).values({
      name: 'Test Chemical A',
      productNumber: 'TC-001',
      unit: 'gallon',
      categoryId: category.id,
      isActive: true,
    }),
  );

  // ── 3. Verify counts ──────────────────────────────────────────────────────

  console.log('');

  const [adminRow] = await step('Verify admin user seeded', () =>
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(eq(usersTable.name, 'TestAdmin')),
  );
  if (adminRow?.count !== 1) {
    throw new Error(`Expected 1 TestAdmin row, found ${adminRow?.count ?? 0}`);
  }

  const [productRow] = await step('Verify product seeded', () =>
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(productsTable)
      .where(eq(productsTable.productNumber, 'TC-001')),
  );
  if (productRow?.count !== 1) {
    throw new Error(`Expected 1 TC-001 product, found ${productRow?.count ?? 0}`);
  }

  console.log('\nSeed complete.');
}

main()
  .catch((err) => {
    console.error('\nSeed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => pool.end());
