"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function LiveIndicator() {
  const [connected, setConnected] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let es: EventSource | null = null;

    try {
      es = new EventSource("/api/alerts/stream");

      es.addEventListener("connected", () => {
        setConnected(true);
      });

      es.addEventListener("alerts", (event) => {
        // New alerts arrived — refresh the page data
        router.refresh();
      });

      es.onerror = () => {
        setConnected(false);
        // EventSource auto-reconnects
      };
    } catch {
      // SSE not supported or failed
    }

    return () => {
      es?.close();
    };
  }, [router]);

  return (
    <div className="flex items-center gap-1.5" aria-live="polite" aria-label={connected ? "Live updates connected" : "Connecting to live updates"}>
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          connected ? "bg-emerald-500 animate-pulse" : "bg-fg-base/30"
        }`}
      />
      <span className="text-xs text-fg-base/60">
        {connected ? "Live" : "Connecting…"}
      </span>
    </div>
  );
}
