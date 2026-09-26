import { Router, type IRouter } from "express";
import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  pushDevicesTable,
  usersTable,
} from "@workspace/db";
import { getUser, requireAuth } from "../lib/auth";
import {
  getPushCapabilities,
  hashRegistration,
  safeDevice,
  setBackupAlertState,
  type DevicePreferences,
  type NotificationPlatform,
  type WebPushSubscription,
} from "../lib/push-notifications";

const router: IRouter = Router();

function validPreferences(value: unknown): value is DevicePreferences {
  if (!value || typeof value !== "object") return false;
  const preferences = value as Record<string, unknown>;
  return (
    typeof preferences.backupEnabled === "boolean" &&
    typeof preferences.inventoryEnabled === "boolean"
  );
}

function validExpoToken(value: unknown): value is string {
  return typeof value === "string" && /^(Expo|Exponent)PushToken\[[^\]]+\]$/.test(value);
}

function validWebSubscription(value: unknown): value is WebPushSubscription {
  if (!value || typeof value !== "object") return false;
  const subscription = value as Record<string, unknown>;
  if (typeof subscription.endpoint !== "string") return false;
  try {
    const endpoint = new URL(subscription.endpoint);
    const hostname = endpoint.hostname.toLowerCase();
    const supportedHost =
      hostname === "fcm.googleapis.com" ||
      hostname === "fcmregistrations.googleapis.com" ||
      hostname === "push.services.mozilla.com" ||
      hostname.endsWith(".push.services.mozilla.com") ||
      hostname === "web.push.apple.com" ||
      hostname.endsWith(".notify.windows.com");
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      (endpoint.port && endpoint.port !== "443") ||
      !supportedHost
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const keys = subscription.keys;
  if (!keys || typeof keys !== "object") return false;
  const keyRecord = keys as Record<string, unknown>;
  return (
    typeof keyRecord.p256dh === "string" &&
    /^[A-Za-z0-9_-]{40,160}$/.test(keyRecord.p256dh) &&
    typeof keyRecord.auth === "string" &&
    /^[A-Za-z0-9_-]{16,80}$/.test(keyRecord.auth)
  );
}

async function activeUser(userId: number) {
  const [user] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.id, userId),
        eq(usersTable.isActive, true),
        isNull(usersTable.deletedAt),
      ),
    )
    .limit(1);
  return user;
}

router.get("/notifications/devices", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  if (!(await activeUser(user.userId))) {
    res.status(401).json({ error: "Active account required" });
    return;
  }
  const devices = await db
    .select()
    .from(pushDevicesTable)
    .where(eq(pushDevicesTable.userId, user.userId))
    .orderBy(pushDevicesTable.createdAt);
  res.json({
    devices: devices.map(safeDevice),
    capabilities: getPushCapabilities(),
  });
});

router.post("/notifications/devices", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  if (!(await activeUser(user.userId))) {
    res.status(401).json({ error: "Active account required" });
    return;
  }
  const body = req.body as {
    platform?: unknown;
    subscription?: unknown;
    preferences?: unknown;
  };
  if (!validPreferences(body.preferences)) {
    res.status(400).json({ error: "Both notification preferences must be boolean" });
    return;
  }

  let platform: NotificationPlatform;
  let registrationValue: string;
  let subscription: unknown;
  if (body.platform === "expo" && validExpoToken(
    body.subscription && typeof body.subscription === "object"
      ? (body.subscription as Record<string, unknown>).expoPushToken
      : null,
  )) {
    platform = "expo";
    registrationValue = (body.subscription as { expoPushToken: string }).expoPushToken;
    subscription = { expoPushToken: registrationValue };
  } else if (body.platform === "web" && validWebSubscription(body.subscription)) {
    platform = "web";
    registrationValue = body.subscription.endpoint;
    subscription = {
      endpoint: body.subscription.endpoint,
      keys: {
        p256dh: body.subscription.keys.p256dh,
        auth: body.subscription.keys.auth,
      },
    };
  } else {
    res.status(400).json({ error: "Unsupported platform or invalid push registration" });
    return;
  }

  const registrationKey = hashRegistration(platform, registrationValue);
  const [device] = await db
    .insert(pushDevicesTable)
    .values({
      userId: user.userId,
      platform,
      registrationKey,
      subscription,
      backupEnabled: user.role === "admin" && body.preferences.backupEnabled,
      inventoryEnabled: body.preferences.inventoryEnabled,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: pushDevicesTable.registrationKey,
      set: {
        userId: user.userId,
        platform,
        subscription,
        backupEnabled: user.role === "admin" && body.preferences.backupEnabled,
        inventoryEnabled: body.preferences.inventoryEnabled,
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.status(201).json({ device: safeDevice(device) });
});

router.patch("/notifications/devices/:id", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  if (!(await activeUser(user.userId))) {
    res.status(401).json({ error: "Active account required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid device ID" });
    return;
  }
  const body = req.body as { preferences?: unknown };
  if (!validPreferences(body.preferences)) {
    res.status(400).json({ error: "Both notification preferences must be boolean" });
    return;
  }

  const [device] = await db
    .update(pushDevicesTable)
    .set({
      backupEnabled: user.role === "admin" && body.preferences.backupEnabled,
      inventoryEnabled: body.preferences.inventoryEnabled,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(pushDevicesTable.id, id),
        eq(pushDevicesTable.userId, user.userId),
      ),
    )
    .returning();
  if (!device) {
    res.status(404).json({ error: "Device registration not found" });
    return;
  }
  res.json({ device: safeDevice(device) });
});

router.delete("/notifications/devices/:id", requireAuth, async (req, res): Promise<void> => {
  const user = getUser(req);
  if (!(await activeUser(user.userId))) {
    res.status(401).json({ error: "Active account required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid device ID" });
    return;
  }
  const [device] = await db
    .delete(pushDevicesTable)
    .where(
      and(
        eq(pushDevicesTable.id, id),
        eq(pushDevicesTable.userId, user.userId),
      ),
    )
    .returning({ id: pushDevicesTable.id });
  if (!device) {
    res.status(404).json({ error: "Device registration not found" });
    return;
  }
  res.status(204).end();
});

router.post("/backup/events", async (req, res): Promise<void> => {
  const configuredToken = process.env.BACKUP_PUSH_TOKEN;
  if (!configuredToken) {
    res.status(503).json({ error: "Backup event intake is not configured" });
    return;
  }
  const suppliedToken = req.get("x-backup-push-token") ?? "";
  const expected = Buffer.from(configuredToken);
  const supplied = Buffer.from(suppliedToken);
  if (
    expected.length === 0 ||
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = req.body as { issue?: unknown; state?: unknown };
  if (
    (body.issue !== "backup_run" && body.issue !== "backup_freshness") ||
    (body.state !== "alert" && body.state !== "healthy")
  ) {
    res.status(400).json({ error: "Invalid backup event" });
    return;
  }
  try {
    await setBackupAlertState(body.issue, body.state === "alert");
  } catch {
    res.status(503).json({ error: "Backup event could not be recorded" });
    return;
  }
  res.status(202).json({ accepted: true });
});

export default router;