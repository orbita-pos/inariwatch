"use client";

import { useState } from "react";
import { Bell, BellOff, Loader2, Check } from "lucide-react";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function PushNotificationsButton() {
  const [status, setStatus] = useState<"idle" | "loading" | "enabled" | "denied" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!VAPID_PUBLIC_KEY) return null;

  const handleEnable = async () => {
    setStatus("loading");
    setError(null);

    try {
      // Check permission
      const permission = await Notification.requestPermission();
      if (permission === "denied") {
        setStatus("denied");
        return;
      }

      // Register service worker
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      // Subscribe to push
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });

      const sub = subscription.toJSON();

      // Send to server
      const res = await fetch("/api/notifications/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save subscription");
      }

      setStatus("enabled");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStatus("error");
    }
  };

  return (
    <div>
      {status === "enabled" ? (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-green-400">
          <Check className="h-3.5 w-3.5" />
          Push notifications enabled
        </span>
      ) : status === "denied" ? (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-zinc-500">
          <BellOff className="h-3.5 w-3.5" />
          Notifications blocked in browser settings
        </span>
      ) : (
        <button
          onClick={handleEnable}
          disabled={status === "loading"}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#222] bg-transparent px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-all disabled:opacity-40"
        >
          {status === "loading" ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Enabling...
            </>
          ) : (
            <>
              <Bell className="h-3.5 w-3.5" />
              Enable push notifications
            </>
          )}
        </button>
      )}
      {error && <p className="mt-1.5 text-[12px] text-red-400">{error}</p>}
    </div>
  );
}
