import React, { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import Constants from "expo-constants";
import { Stack } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetNotificationDevices,
  useRegisterNotificationDevice,
  useRemoveNotificationDevice,
  useUpdateNotificationDevice,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

type Preferences = { backupEnabled: boolean; inventoryEnabled: boolean };
type Device = {
  id: number;
  platform: "expo" | "web";
  backupEnabled: boolean;
  inventoryEnabled: boolean;
  isActive: boolean;
  createdAt: string;
};

const EMPTY_PREFERENCES: Preferences = {
  backupEnabled: false,
  inventoryEnabled: false,
};

function webPushApplicationKey(value: string): ArrayBuffer {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

function browserSupportMessage(configured: boolean): string | null {
  if (Platform.OS !== "web") return null;
  if (typeof window === "undefined" || !window.isSecureContext) {
    return "Browser notifications require a secure HTTPS connection.";
  }
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    typeof Notification === "undefined"
  ) {
    return "This browser does not support web push notifications.";
  }
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (isIos && !isStandalone) {
    return "On iPhone or iPad, add this app to the Home Screen and open it from there to enable push notifications.";
  }
  if (!configured) {
    return "Browser push is not configured on this server yet.";
  }
  if (Notification.permission === "denied") {
    return "Notifications are blocked in browser settings. Allow them there, then try again.";
  }
  return null;
}

export default function NotificationSettingsScreen() {
  const colors = useColors();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const queryClient = useQueryClient();
  const devicesQuery = useGetNotificationDevices();
  const registerMutation = useRegisterNotificationDevice();
  const updateMutation = useUpdateNotificationDevice();
  const removeMutation = useRemoveNotificationDevice();
  const [newPreferences, setNewPreferences] = useState<Preferences>(EMPTY_PREFERENCES);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const devices = (devicesQuery.data?.devices ?? []) as Device[];
  const capabilities = devicesQuery.data?.capabilities;
  const webMode = Platform.OS === "web";
  const supportMessage = browserSupportMessage(
    Boolean(capabilities?.webPushConfigured && capabilities.webPushPublicKey),
  );
  const nativeProjectId =
    Constants.easConfig?.projectId ??
    Constants.expoConfig?.extra?.eas?.projectId ??
    undefined;
  const nativeSupportMessage =
    Platform.OS !== "web" && !nativeProjectId
      ? "Native push needs an installed iOS or Android build linked to an EAS project with APNs/FCM credentials. Expo Go cannot verify push delivery."
      : null;
  const isBusy =
    registerMutation.isPending ||
    updateMutation.isPending ||
    removeMutation.isPending;

  const refreshDevices = async () => {
    await queryClient.invalidateQueries({ queryKey: devicesQuery.queryKey });
  };

  const registerCurrentDevice = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      if (webMode) {
        const reason = browserSupportMessage(
          Boolean(capabilities?.webPushConfigured && capabilities.webPushPublicKey),
        );
        if (reason) throw new Error(reason);
        if (!capabilities?.webPushPublicKey) {
          throw new Error("The browser push public key is not available.");
        }
        if (Notification.permission === "default") {
          const permission = await Notification.requestPermission();
          if (permission !== "granted") {
            throw new Error("Browser notification permission was not granted.");
          }
        }
        const basePath = (process.env.EXPO_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
        const serviceWorker = await navigator.serviceWorker.register(
          `${basePath}/push-service-worker.js`,
          { scope: `${basePath}/` },
        );
        await navigator.serviceWorker.ready;
        let subscription = await serviceWorker.pushManager.getSubscription();
        if (!subscription) {
          subscription = await serviceWorker.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: webPushApplicationKey(capabilities.webPushPublicKey),
          });
        }
        const serialized = subscription.toJSON();
        if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) {
          throw new Error("The browser returned an incomplete push registration.");
        }
        await registerMutation.mutateAsync({
          data: {
            platform: "web",
            subscription: {
              endpoint: serialized.endpoint,
              keys: {
                p256dh: serialized.keys.p256dh,
                auth: serialized.keys.auth,
              },
            },
            preferences: newPreferences,
          },
        });
      } else {
        if (!nativeProjectId) throw new Error(nativeSupportMessage ?? "Native push is not configured.");
        const Notifications = await import("expo-notifications");
        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("default", {
            name: "Default",
            importance: Notifications.AndroidImportance.DEFAULT,
          });
        }
        let permission = await Notifications.getPermissionsAsync();
        if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
        if (!permission.granted) {
          throw new Error("Notification permission was not granted. Enable it in device settings to continue.");
        }
        const token = await Notifications.getExpoPushTokenAsync({ projectId: nativeProjectId });
        await registerMutation.mutateAsync({
          data: {
            platform: "expo",
            subscription: { expoPushToken: token.data },
            preferences: newPreferences,
          },
        });
      }
      setSuccessMessage("This device is registered for the selected alerts.");
      await refreshDevices();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not register this device.");
    }
  };

  const updatePreferences = async (device: Device, preferences: Preferences) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await updateMutation.mutateAsync({
        id: device.id,
        data: { preferences },
      });
      await refreshDevices();
    } catch {
      setErrorMessage("Could not save the notification preferences. Try again.");
    }
  };

  const removeDevice = async (device: Device) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await removeMutation.mutateAsync({ id: device.id });
      await refreshDevices();
    } catch {
      setErrorMessage("Could not remove this device registration. Try again.");
    }
  };

  const updateNewPreference = (key: keyof Preferences, value: boolean) => {
    setNewPreferences((current) => ({ ...current, [key]: value }));
  };

  if (devicesQuery.isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
        <Text style={[styles.loading, { color: colors.mutedForeground }]}>Loading alert settings…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: "Notifications" }} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
          Push notifications
        </Text>
        <Text style={[styles.description, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
          {isAdmin
            ? "Choose which inventory and backup alerts this device receives. Notifications are optional and can be removed at any time."
            : "Choose which inventory alerts this device receives. Backup alerts are available to administrators. Notifications are optional and can be removed at any time."}
        </Text>

        {(supportMessage || nativeSupportMessage) && (
          <View style={[styles.notice, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Text style={[styles.noticeText, { color: colors.foreground, fontFamily: "Inter_400Regular" }]}>
              {supportMessage ?? nativeSupportMessage}
            </Text>
          </View>
        )}
        {devicesQuery.isError && (
          <View style={[styles.notice, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Text style={[styles.noticeText, { color: colors.foreground }]}>
              Could not load notification settings. Check your connection and try again.
            </Text>
          </View>
        )}
        {errorMessage && (
          <View style={[styles.notice, styles.errorNotice, { borderColor: colors.destructive }]}>
            <Text style={[styles.noticeText, { color: colors.destructive }]}>{errorMessage}</Text>
          </View>
        )}
        {successMessage && (
          <Text style={[styles.successText, { color: colors.success }]}>{successMessage}</Text>
        )}

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
            This device
          </Text>
          {isAdmin && (
            <PreferenceSwitch
              label="Backup failures and stale backups"
              value={newPreferences.backupEnabled}
              disabled={isBusy || Boolean(supportMessage || nativeSupportMessage)}
              colors={colors}
              onChange={(value) => updateNewPreference("backupEnabled", value)}
            />
          )}
          <PreferenceSwitch
            label="Below-minimum and overstock alerts"
            value={newPreferences.inventoryEnabled}
            disabled={isBusy || Boolean(supportMessage || nativeSupportMessage)}
            colors={colors}
            onChange={(value) => updateNewPreference("inventoryEnabled", value)}
          />
          <Pressable
            accessibilityRole="button"
            disabled={isBusy || Boolean(supportMessage || nativeSupportMessage)}
            onPress={registerCurrentDevice}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.primary },
              (pressed || isBusy || supportMessage || nativeSupportMessage) && { opacity: 0.6 },
            ]}
          >
            {registerMutation.isPending ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={[styles.primaryButtonText, { fontFamily: "Inter_700Bold" }]}>
                Enable on this device
              </Text>
            )}
          </Pressable>
        </View>

        <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
          Registered devices
        </Text>
        {devices.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            No devices are registered yet.
          </Text>
        ) : (
          devices.map((device) => (
            <View
              key={device.id}
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={styles.deviceHeader}>
                <Text style={[styles.cardTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
                  {device.platform === "web" ? "Browser" : "iOS / Android"}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => removeDevice(device)}
                  disabled={isBusy}
                  hitSlop={8}
                >
                  <Text style={[styles.removeText, { color: colors.destructive }]}>Remove</Text>
                </Pressable>
              </View>
              {isAdmin && (
                <PreferenceSwitch
                  label="Backup failures and stale backups"
                  value={device.backupEnabled}
                  disabled={isBusy || !device.isActive}
                  colors={colors}
                  onChange={(value) =>
                    updatePreferences(device, { ...device, backupEnabled: value })
                  }
                />
              )}
              <PreferenceSwitch
                label="Below-minimum and overstock alerts"
                value={device.inventoryEnabled}
                disabled={isBusy || !device.isActive}
                colors={colors}
                onChange={(value) =>
                  updatePreferences(device, { ...device, inventoryEnabled: value })
                }
              />
              {!device.isActive && (
                <Text style={[styles.inactiveText, { color: colors.mutedForeground }]}>
                  This registration expired and will not receive alerts. Remove it and register again.
                </Text>
              )}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function PreferenceSwitch({
  label,
  value,
  disabled,
  colors,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled: boolean;
  colors: ReturnType<typeof useColors>;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.preferenceRow}>
      <Text style={[styles.preferenceLabel, { color: colors.foreground, fontFamily: "Inter_400Regular" }]}>
        {label}
      </Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor="#ffffff"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 20, paddingBottom: 40, gap: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loading: { fontSize: 14 },
  title: { fontSize: 24, marginTop: 8 },
  description: { fontSize: 14, lineHeight: 21, marginBottom: 4 },
  notice: { borderWidth: 1, borderRadius: 12, padding: 14 },
  errorNotice: { backgroundColor: "transparent" },
  noticeText: { fontSize: 13, lineHeight: 19 },
  successText: { fontSize: 13, lineHeight: 19 },
  card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 10 },
  cardTitle: { fontSize: 16 },
  preferenceRow: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 14 },
  preferenceLabel: { flex: 1, fontSize: 14, lineHeight: 20 },
  primaryButton: { minHeight: 46, justifyContent: "center", alignItems: "center", borderRadius: 10, marginTop: 6, paddingHorizontal: 16 },
  primaryButtonText: { color: "#ffffff", fontSize: 14 },
  sectionTitle: { fontSize: 18, marginTop: 8 },
  emptyText: { fontSize: 14, paddingVertical: 10 },
  deviceHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  removeText: { fontSize: 14, fontWeight: "600" },
  inactiveText: { fontSize: 12, lineHeight: 18 },
});