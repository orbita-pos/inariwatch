"use client";

import { useState } from "react";
import { Bell, BellOff, Loader2, Check } from "lucide-react";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function urlBase64ToUint8Array(base64String: string) {
  try {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    // Replace URL-safe base64 characters with standard base64 characters
    const base64 = (base64String.trim() + padding)
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  } catch (err) {
    console.error("VAPID key decode error:", err);
    throw new Error("Invalid VAPID public key format");
  }
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

      // Register service worker and wait for it to be active
      await navigator.serviceWorker.register("/sw.js");
      const reg = await navigator.serviceWorker.ready;

      // Clear any stale subscription (different VAPID key causes "push service error")
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await existing.unsubscribe();
      }

      const convertedVapidKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      
      console.log("Push reg info: Key exists?", !!VAPID_PUBLIC_KEY, "Length:", VAPID_PUBLIC_KEY.length);
      console.log("First 10 chars:", VAPID_PUBLIC_KEY.substring(0, 10));

      // Subscribe to push
      let subscription: PushSubscription;
      try {
        subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: convertedVapidKey,
        });
      } catch (err: any) {
        console.error("First subscribe attempt failed:", err);
        // Fallback: try with the raw string (some browsers prefer this)
        try {
          subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: VAPID_PUBLIC_KEY,
          });
        } catch (err2: any) {
          console.error("Second subscribe attempt failed:", err2);
          throw new Error(err.message || "Push service error");
        }
      }

      const sub = subscription.toJSON();

      // Send to server
      const res = await fetch("/api/notifications/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub }),
      });

      if (!res.ok) {
        let errMsg = "Failed to save subscription";
        try {
          const data = await res.json();
          errMsg = data.error || errMsg;
        } catch {}
        throw new Error(errMsg);
      }

      setStatus("enabled");
    } catch (err) {
      let msg = err instanceof Error ? err.message : "Something went wrong";
      
      // Provide a helpful error message for Brave users since Brave blocks FCM by default
      if (msg.includes("push service error") && typeof navigator !== "undefined" && "brave" in navigator) {
        msg = "Brave blocks push notifications by default. Enable 'Use Google services for push messaging' in brave://settings/privacy, then restart the browser.";
      }
      
      setError(msg);
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
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-fg-base transition-all disabled:opacity-40"
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
