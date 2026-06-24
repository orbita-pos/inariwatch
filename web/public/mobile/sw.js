/**
 * S12 — service worker for the Inari mobile PWA.
 *
 * Two responsibilities:
 *   1. Cache the PWA shell (`/mobile/`) for offline read of the
 *      most-recent inbox.
 *   2. Receive web-push events + show notifications + open
 *      `/mobile/alert/<id>` on click.
 *
 * Plain JS on purpose — Next.js App Router does not bundle TS service
 * workers and pulling in `next-pwa` would be excessive for a single
 * route group (see S12_PROMPT.md gotcha #4).
 *
 * This file's path is `/public/mobile/sw.js` so it serves at
 * `/mobile/sw.js` and its scope is `/mobile/*`. API calls (`/api/...`)
 * are NOT intercepted — that's intentional; we don't want to interpose
 * between the device JWT bearer + the API.
 */

/* global self, caches, clients */
"use strict";

const CACHE_VERSION = "inari-mobile-v1";
const SHELL_PATHS = ["/mobile", "/mobile/inbox", "/mobile/pair", "/mobile/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_PATHS).catch(() => undefined)),
  );
  // Activate immediately on first install — no waiting for tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/mobile")) return;
  if (url.pathname.startsWith("/mobile/sw.js")) return;
  // Network-first for the shell paths so the user sees fresh content
  // when online. Fall back to the cached copy on offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone)).catch(() => undefined);
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || new Response("offline", { status: 503 }))),
  );
});

// ── Push handler ───────────────────────────────────────────────────────
//
// Payload shape (matches what /api/mobile/push/test sends):
//   { title: string, body: string, alert_id?: string }
self.addEventListener("push", (event) => {
  let payload = { title: "Inari", body: "New alert" };
  try {
    if (event.data) payload = JSON.parse(event.data.text());
  } catch {
    // ignore — fall back to the default payload
  }
  const options = {
    body:  payload.body,
    icon:  "/mobile/icon-192.png",
    badge: "/mobile/icon-192.png",
    data:  { alert_id: payload.alert_id },
    tag:   payload.alert_id ?? "inari-alert",
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const alertId = event.notification.data && event.notification.data.alert_id;
  const url = alertId ? `/mobile/alert/${alertId}` : "/mobile/inbox";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes("/mobile") && "focus" in w) {
          w.navigate(url);
          return w.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
