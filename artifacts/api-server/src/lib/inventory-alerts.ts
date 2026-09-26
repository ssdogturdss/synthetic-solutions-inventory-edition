import { eq, inArray } from "drizzle-orm";
import {
  db,
  productsTable,
  storesTable,
  warehousesTable,
} from "@workspace/db";
import { getStockAlerts } from "../routes/reports";
import { logger } from "./logger";
import { reconcileInventoryAlert } from "./push-notifications";

export async function reconcileStockAlertScope(params: {
  storeId: number | null;
  warehouseId: number | null;
  productIds: number[];
}): Promise<void> {
  const productIds = [...new Set(params.productIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (productIds.length === 0) return;
  try {
    const products = await db
      .select()
      .from(productsTable)
      .where(inArray(productsTable.id, productIds));
    const [store] = params.storeId !== null
      ? await db.select().from(storesTable).where(eq(storesTable.id, params.storeId))
      : [];
    const [warehouse] = params.warehouseId !== null
      ? await db
          .select()
          .from(warehousesTable)
          .where(eq(warehousesTable.id, params.warehouseId))
      : [];
    const locationName = store?.name ?? warehouse?.name ?? "Inventory location";

    const [belowAlerts, overAlerts] = await Promise.all([
      params.storeId !== null
        ? getStockAlerts(String(params.storeId), "below")
        : getStockAlerts(undefined, "below", String(params.warehouseId)),
      params.storeId !== null
        ? getStockAlerts(String(params.storeId), "over")
        : getStockAlerts(undefined, "over", String(params.warehouseId)),
    ]);
    const scopedBelow = params.storeId !== null
      ? belowAlerts.filter((alert) => alert.storeId === params.storeId && alert.warehouseId == null)
      : belowAlerts.filter((alert) => alert.warehouseId === params.warehouseId);
    const scopedOver = params.storeId !== null
      ? overAlerts.filter((alert) => alert.storeId === params.storeId && alert.warehouseId == null)
      : overAlerts.filter((alert) => alert.warehouseId === params.warehouseId);

    await Promise.all(
      products.flatMap((product) =>
        ([
          { alertType: "below" as const, alerts: scopedBelow },
          { alertType: "over" as const, alerts: scopedOver },
        ]).map(async ({ alertType, alerts }) => {
          const activeAlert = alerts.find((alert) => alert.productId === product.id);
          const locationKey = params.storeId !== null
            ? `store:${params.storeId}`
            : `warehouse:${params.warehouseId}`;
          await reconcileInventoryAlert({
            alertKey: `${locationKey}:product:${product.id}:${alertType}`,
            active: Boolean(activeAlert),
            storeId: params.storeId,
            warehouseId: params.warehouseId,
            productId: product.id,
            productName: activeAlert?.productName ?? product.name,
            locationName: activeAlert?.storeName ?? locationName,
            alertType,
            currentLevel: activeAlert?.currentLevel,
            threshold: activeAlert?.threshold,
            unit: activeAlert?.unit ?? product.unit,
          });
        }),
      ),
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        storeId: params.storeId,
        warehouseId: params.warehouseId,
      },
      "Stock alert reconciliation failed after inventory commit",
    );
  }
}