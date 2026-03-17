// Kairo Push Notification Service Worker

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Kairo Alert", body: event.data.text() };
  }

  const { title, body, severity, alertId } = payload;

  const options = {
    body: body || "",
    icon: "/logo-kairo/favicon-96x96.png",
    badge: "/logo-kairo/favicon-96x96.png",
    tag: alertId || undefined,
    data: {
      url: alertId ? "/alerts/" + alertId : "/alerts",
    },
  };

  event.waitUntil(self.registration.showNotification(title || "Kairo Alert", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/alerts";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus an existing window if one is open
        for (const client of clientList) {
          if (client.url.includes(url) && "focus" in client) {
            return client.focus();
          }
        }
        // Otherwise open a new window
        return self.clients.openWindow(url);
      })
  );
});
