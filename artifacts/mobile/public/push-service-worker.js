/* Web Push worker served from the app root by the custom Expo artifact server. */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = typeof payload.title === "string" ? payload.title : "Inventory alert";
  const body = typeof payload.body === "string" ? payload.body : "Open the app to review this alert.";
  const url = typeof payload.url === "string" ? payload.url : "";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl = event.notification.data?.url;
  const relativeUrl = typeof rawUrl === "string" ? rawUrl.replace(/^\/+/, "") : "";
  const destination = new URL(relativeUrl, self.registration.scope);
  if (destination.origin !== self.location.origin) return;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => "focus" in client);
      if (existing && "focus" in existing) {
        if ("navigate" in existing) void existing.navigate(destination.href);
        return existing.focus();
      }
      return self.clients.openWindow(destination.href);
    }),
  );
});