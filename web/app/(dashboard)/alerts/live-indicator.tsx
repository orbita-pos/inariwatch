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
    <div className="flex items-center gap-1.5">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          connected ? "bg-green-400 animate-pulse" : "bg-zinc-600"
        }`}
      />
      <span className="text-xs text-zinc-600">
        {connected ? "Live" : "Connecting…"}
      </span>
    </div>
  );
}
