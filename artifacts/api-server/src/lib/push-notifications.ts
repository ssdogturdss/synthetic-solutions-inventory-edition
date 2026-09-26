import { createHash, randomUUID } from "node:crypto";
import webPush from "web-push";
import {
  and,
  desc,
  eq,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  backupAlertStatesTable,
  db,
  inventoryAlertStatesTable,
  pushDevicesTable,
  pushOutboxTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./logger";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type NotificationCategory = "backup" | "inventory";
export type NotificationPlatform = "expo" | "web";
export type DevicePreferences = {
  backupEnabled: boolean;
  inventoryEnabled: boolean;
};
export type WebPushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

const MAX_PUSH_ATTEMPTS = 8;
const OUTBOX_BATCH_SIZE = 40;
const WORKER_INTERVAL_MS = 20_000;

function webPushConfiguration() {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.WEB_PUSH_VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export function getPushCapabilities() {
  const config = webPushConfiguration();
  return {
    webPushConfigured: Boolean(config),
    webPushPublicKey: config?.publicKey ?? null,
  };
}

export function hashRegistration(platform: NotificationPlatform, value: string): string {
  return createHash("sha256").update(`${platform}:${value}`).digest("hex");
}

export function safeDevice(device: typeof pushDevicesTable.$inferSelect) {
  return {
    id: device.id,
    platform: device.platform,
    backupEnabled: device.backupEnabled,
    inventoryEnabled: device.inventoryEnabled,
    isActive: device.isActive,
    createdAt: device.createdAt.toISOString(),
  };
}

function backoffMs(attempt: number): number {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

function recordErrorCode(error: unknown): string {
  if (error instanceof PushDeliveryError) return error.code;
  return "provider_unavailable";
}

class PushDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly expired = false,
  ) {
    super(code);
  }
}

function expoErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object") return null;
  const ticket = data[0] as { status?: unknown; details?: { error?: unknown } };
  if (ticket.status !== "error") return null;
  return typeof ticket.details?.error === "string" ? ticket.details.error : "provider_rejected";
}

async function sendExpoPush(
  subscription: unknown,
  notification: { title: string; body: string; route: string },
): Promise<void> {
  const token =
    subscription && typeof subscription === "object"
      ? (subscription as { expoPushToken?: unknown }).expoPushToken
      : null;
  if (typeof token !== "string" || !/^(Expo|Exponent)PushToken\[[^\]]+\]$/.test(token)) {
    throw new PushDeliveryError("invalid_registration", true);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: token,
        sound: "default",
        title: notification.title,
        body: notification.body,
        data: { route: notification.route },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PushDeliveryError(
        response.status === 429 || response.status >= 500
          ? "provider_unavailable"
          : "provider_rejected",
      );
    }
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new PushDeliveryError("invalid_provider_response");
    }
    const code = expoErrorCode(responseBody);
    if (code === "DeviceNotRegistered") {
      throw new PushDeliveryError("registration_expired", true);
    }
    if (code) throw new PushDeliveryError("provider_rejected");
  } catch (error) {
    if (error instanceof PushDeliveryError) throw error;
    throw new PushDeliveryError("provider_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

async function sendWebPush(
  subscription: unknown,
  notification: { title: string; body: string; route: string },
): Promise<void> {
  const config = webPushConfiguration();
  if (!config) throw new PushDeliveryError("web_push_not_configured");
  if (!subscription || typeof subscription !== "object") {
    throw new PushDeliveryError("invalid_registration", true);
  }
  try {
    webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    await webPush.sendNotification(
      subscription as WebPushSubscription,
      JSON.stringify({
        title: notification.title,
        body: notification.body,
        url: notification.route,
      }),
      { TTL: 3600 },
    );
  } catch (error) {
    const statusCode =
      error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : 0;
    if (statusCode === 404 || statusCode === 410) {
      throw new PushDeliveryError("registration_expired", true);
    }
    throw new PushDeliveryError(
      statusCode === 401 || statusCode === 403
        ? "provider_rejected"
        : "provider_unavailable",
    );
  }
}

async function sendDevicePush(
  platform: NotificationPlatform,
  subscription: unknown,
  notification: { title: string; body: string; route: string },
): Promise<void> {
  if (platform === "expo") {
    await sendExpoPush(subscription, notification);
    return;
  }
  await sendWebPush(subscription, notification);
}

async function enqueueForDevices(
  tx: Transaction,
  devices: Array<{ id: number }>,
  category: NotificationCategory,
  notification: { title: string; body: string; route: string },
  eventId: string,
  scope: { storeId: number | null; warehouseId: number | null } = {
    storeId: null,
    warehouseId: null,
  },
): Promise<void> {
  if (devices.length === 0) return;
  await tx
    .insert(pushOutboxTable)
    .values(
      devices.map((device) => ({
        dedupeKey: `${eventId}:${device.id}`,
        deviceId: device.id,
        category,
        scopeStoreId: scope.storeId,
        scopeWarehouseId: scope.warehouseId,
        title: notification.title.slice(0, 100),
        body: notification.body.slice(0, 240),
        route: notification.route,
      })),
    )
    .onConflictDoNothing({ target: pushOutboxTable.dedupeKey });
}

async function activeDevicesForBackup(tx: Transaction) {
  return tx
    .select({ id: pushDevicesTable.id })
    .from(pushDevicesTable)
    .innerJoin(usersTable, eq(usersTable.id, pushDevicesTable.userId))
    .where(
      and(
        eq(pushDevicesTable.isActive, true),
        eq(pushDevicesTable.backupEnabled, true),
        eq(usersTable.role, "admin"),
        eq(usersTable.isActive, true),
        isNull(usersTable.deletedAt),
      ),
    );
}

export async function setBackupAlertState(
  alertKey: "backup_run" | "backup_freshness",
  isActive: boolean,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [transition] = await tx
        .insert(backupAlertStatesTable)
        .values({ alertKey, isActive, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: backupAlertStatesTable.alertKey,
          set: { isActive, updatedAt: new Date() },
          setWhere: isActive
            ? eq(backupAlertStatesTable.isActive, false)
            : eq(backupAlertStatesTable.isActive, true),
        })
        .returning({ alertKey: backupAlertStatesTable.alertKey });
      if (!transition || !isActive) return;

      const devices = await activeDevicesForBackup(tx);
      const freshness = alertKey === "backup_freshness";
      await enqueueForDevices(
        tx,
        devices,
        "backup",
        {
          title: freshness ? "Backup freshness needs attention" : "Backup run failed",
          body: freshness
            ? "A local or off-server backup is missing or stale. Check Backup Health."
            : "The latest backup run failed. Check Backup Health before relying on inventory data.",
          route: "/admin/backup-health",
        },
        `backup:${alertKey}:${randomUUID()}`,
      );
    });
    if (isActive && process.env.NODE_ENV !== "test") void dispatchPushOutbox();
  } catch (error) {
    logger.error({ err: error, alertKey }, "Could not record backup push alert");
    throw error;
  }
}

export async function reconcileInventoryAlert(
  params: {
    alertKey: string;
    active: boolean;
    storeId: number | null;
    warehouseId: number | null;
    productName: string;
    productId: number;
    locationName: string;
    alertType: "below" | "over";
    currentLevel?: string;
    threshold?: string;
    unit?: string | null;
  },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [transition] = await tx
        .insert(inventoryAlertStatesTable)
        .values({
          alertKey: params.alertKey,
          isActive: params.active,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: inventoryAlertStatesTable.alertKey,
          set: { isActive: params.active, updatedAt: new Date() },
          setWhere: params.active
            ? eq(inventoryAlertStatesTable.isActive, false)
            : eq(inventoryAlertStatesTable.isActive, true),
        })
        .returning({ alertKey: inventoryAlertStatesTable.alertKey });
      if (!transition || !params.active) return;

      const locationAccess =
        params.storeId === null
          ? eq(usersTable.role, "admin")
          : or(
              eq(usersTable.role, "admin"),
              and(
                eq(usersTable.role, "store_user"),
                eq(usersTable.storeId, params.storeId),
              ),
            );
      const devices = await tx
        .select({ id: pushDevicesTable.id })
        .from(pushDevicesTable)
        .innerJoin(usersTable, eq(usersTable.id, pushDevicesTable.userId))
        .where(
          and(
            eq(pushDevicesTable.isActive, true),
            eq(pushDevicesTable.inventoryEnabled, true),
            eq(usersTable.isActive, true),
            isNull(usersTable.deletedAt),
            locationAccess,
          ),
        );
      const conditionText =
        params.alertType === "below" ? "below minimum" : "above maximum";
      const thresholdName =
        params.alertType === "below" ? "minimum" : "maximum";
      const amount = params.currentLevel
        ? ` Current level: ${params.currentLevel}${params.unit ? ` ${params.unit}` : ""}.`
        : "";
      const threshold = params.threshold
        ? ` ${thresholdName}: ${params.threshold}${params.unit ? ` ${params.unit}` : ""}.`
        : "";
      await enqueueForDevices(
        tx,
        devices,
        "inventory",
        {
          title: `${params.productName} ${conditionText}`,
          body: `${params.productName} at ${params.locationName} is ${conditionText}.${amount}${threshold}`,
          route: "/reports/alerts",
        },
        `inventory:${params.alertKey}:${randomUUID()}`,
        { storeId: params.storeId, warehouseId: params.warehouseId },
      );
    });
    if (params.active && process.env.NODE_ENV !== "test") void dispatchPushOutbox();
  } catch (error) {
    logger.error(
      { err: error, alertKey: params.alertKey },
      "Could not reconcile inventory push alert",
    );
  }
}

async function attemptDelivery(row: typeof pushOutboxTable.$inferSelect): Promise<void> {
  const [target] = await db
    .select({
      platform: pushDevicesTable.platform,
      subscription: pushDevicesTable.subscription,
      isActive: pushDevicesTable.isActive,
      backupEnabled: pushDevicesTable.backupEnabled,
      inventoryEnabled: pushDevicesTable.inventoryEnabled,
      userId: pushDevicesTable.userId,
      userActive: usersTable.isActive,
      deletedAt: usersTable.deletedAt,
      role: usersTable.role,
      storeId: usersTable.storeId,
    })
    .from(pushDevicesTable)
    .innerJoin(usersTable, eq(usersTable.id, pushDevicesTable.userId))
    .where(eq(pushDevicesTable.id, row.deviceId));

  const authorized =
    target &&
    (row.category === "backup"
      ? target.role === "admin" && target.backupEnabled
      : target.inventoryEnabled &&
        (target.role === "admin" ||
          (row.scopeStoreId !== null &&
            target.role === "store_user" &&
            target.storeId === row.scopeStoreId)));
  if (
    !target ||
    !target.isActive ||
    !target.userActive ||
    target.deletedAt ||
    !authorized
  ) {
    await db
      .update(pushOutboxTable)
      .set({
        status: "failed",
        lastErrorCode: authorized ? "recipient_unavailable" : "recipient_not_authorized",
      })
      .where(eq(pushOutboxTable.id, row.id));
    return;
  }

  try {
    await sendDevicePush(target.platform, target.subscription, {
      title: row.title,
      body: row.body,
      route: row.route,
    });
    await db
      .update(pushOutboxTable)
      .set({ status: "sent", sentAt: new Date(), lastErrorCode: null })
      .where(eq(pushOutboxTable.id, row.id));
  } catch (error) {
    const code = recordErrorCode(error);
    if (error instanceof PushDeliveryError && error.expired) {
      await db
        .update(pushDevicesTable)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(pushDevicesTable.id, row.deviceId));
      await db
        .update(pushOutboxTable)
        .set({ status: "failed", lastErrorCode: "registration_expired" })
        .where(eq(pushOutboxTable.id, row.id));
      return;
    }

    const exhausted = row.attempts >= MAX_PUSH_ATTEMPTS;
    const retryAt = new Date(Date.now() + backoffMs(row.attempts));
    await db
      .update(pushOutboxTable)
      .set({
        status: exhausted ? "failed" : "pending",
        nextAttemptAt: retryAt,
        lastErrorCode: code,
      })
      .where(eq(pushOutboxTable.id, row.id));
  }
}

export async function dispatchPushOutbox(): Promise<void> {
  const now = new Date();
  const pending = await db
    .select()
    .from(pushOutboxTable)
    .where(
      and(
        eq(pushOutboxTable.status, "pending"),
        lte(pushOutboxTable.nextAttemptAt, now),
      ),
    )
    .orderBy(desc(pushOutboxTable.createdAt))
    .limit(OUTBOX_BATCH_SIZE);

  for (const candidate of pending) {
    const claimedAt = new Date();
    const [claimed] = await db
      .update(pushOutboxTable)
      .set({
        attempts: sql`${pushOutboxTable.attempts} + 1`,
        nextAttemptAt: new Date(claimedAt.getTime() + 5 * 60_000),
      })
      .where(
        and(
          eq(pushOutboxTable.id, candidate.id),
          eq(pushOutboxTable.status, "pending"),
          lte(pushOutboxTable.nextAttemptAt, claimedAt),
        ),
      )
      .returning();
    if (!claimed) continue;
    try {
      await attemptDelivery(claimed);
    } catch (error) {
      logger.error({ err: error, outboxId: claimed.id }, "Push outbox delivery record failed");
    }
  }
}

let workerStarted = false;
export function startPushNotificationWorker(): void {
  if (workerStarted || process.env.NODE_ENV === "test") return;
  workerStarted = true;
  const timer = setInterval(() => {
    void dispatchPushOutbox().catch((error) => {
      logger.error({ err: error }, "Push notification retry worker failed");
    });
  }, WORKER_INTERVAL_MS);
  timer.unref();
  void dispatchPushOutbox().catch((error) => {
    logger.error({ err: error }, "Initial push notification dispatch failed");
  });
}