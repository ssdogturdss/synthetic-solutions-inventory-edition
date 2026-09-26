import { and, desc, eq, sql } from "drizzle-orm";
import {
  inventorySessionItemsTable, inventorySessionsTable, receivingRecordItemsTable,
  receivingRecordsTable, warehouseInventoryMovementsTable,
} from "@workspace/db";

const units = (value: string | number | null | undefined) => Math.round(Number(value ?? 0) * 1000);

/** Shared integer-milliunit warehouse balance calculation. */
export async function calculateWarehouseStock(db: any, warehouseId: number) {
  const [count] = await db.select().from(inventorySessionsTable)
    .where(and(eq(inventorySessionsTable.warehouseId, warehouseId), eq(inventorySessionsTable.status, "finalized")))
    .orderBy(desc(inventorySessionsTable.finalizedAt)).limit(1);
  const stock = new Map<number, { milliunits: number; lastCountDate: Date | null }>();
  if (count) {
    const items = await db.select().from(inventorySessionItemsTable).where(eq(inventorySessionItemsTable.sessionId, count.id));
    for (const item of items) {
      stock.set(item.productId, { milliunits: units(item.estimatedGallons ?? item.fullContainers), lastCountDate: count.finalizedAt });
    }
  }
  const movements = await db.select().from(warehouseInventoryMovementsTable)
    .where(eq(warehouseInventoryMovementsTable.warehouseId, warehouseId));
  for (const movement of movements) {
    if (count?.finalizedAt && movement.movedAt <= count.finalizedAt) continue;
    const current = stock.get(movement.productId);
    stock.set(movement.productId, {
      milliunits: (current?.milliunits ?? 0) + units(movement.quantity),
      lastCountDate: count?.finalizedAt ?? null,
    });
  }
  const represented = new Set(movements.map((m: any) => m.receivingRecordId).filter((id: number | null): id is number => id != null));
  const legacy = await db.select({
    recordId: receivingRecordsTable.id, productId: receivingRecordItemsTable.productId,
    quantity: receivingRecordItemsTable.quantityReceived, receivedAt: receivingRecordsTable.receivedAt,
  }).from(receivingRecordsTable)
    .innerJoin(receivingRecordItemsTable, eq(receivingRecordItemsTable.receivingRecordId, receivingRecordsTable.id))
    .where(eq(receivingRecordsTable.warehouseId, warehouseId));
  for (const row of legacy) {
    if (represented.has(row.recordId) || (count?.finalizedAt && row.receivedAt <= count.finalizedAt)) continue;
    const current = stock.get(row.productId);
    stock.set(row.productId, { milliunits: (current?.milliunits ?? 0) + units(row.quantity), lastCountDate: count?.finalizedAt ?? null });
  }
  return { count, stock };
}