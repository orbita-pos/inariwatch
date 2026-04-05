"use client";

import { useEffect, useRef, useState } from "react";

interface SessionPlayerProps {
  events: unknown[];
  onTimeChange?: (timeMs: number) => void;
}

export function SessionPlayer({ events, onTimeChange }: SessionPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || events.length === 0) return;

    let player: { destroy?: () => void } | null = null;

    (async () => {
      try {
        // Dynamic import — rrweb-player is client-only
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await import("rrweb-player");
        const RRWebPlayer = mod.default ?? mod;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const instance: any = new RRWebPlayer({
          target: containerRef.current!,
          props: {
            events,
            width: containerRef.current!.clientWidth,
            height: 400,
            autoPlay: false,
            showController: true,
            speedOption: [1, 2, 4, 8],
          },
        });

        player = { destroy: () => instance?.$destroy?.() };

        // Sync time position with parent
        if (onTimeChange && instance?.getReplayer) {
          const replayer = instance.getReplayer();
          replayer?.on?.("event-cast", (data: { offset: number }) => {
            onTimeChange(data.offset);
          });
        }

        setLoaded(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load session player");
      }
    })();

    return () => {
      if (player?.destroy) player.destroy();
      if (containerRef.current) containerRef.current.innerHTML = "";
    };
  }, [events, onTimeChange]);

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-[400px] bg-zinc-950 rounded-xl border border-line">
        <p className="text-zinc-500 text-sm">No session recording available</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line overflow-hidden bg-zinc-950" style={{ isolation: "isolate" }}>
      {/* rrweb-player renders untrusted DOM — CSP and isolation contain it */}
      {error && (
        <div className="p-4 text-sm text-red-400 bg-red-950/20 border-b border-red-900/30">
          Session player error: {error}
        </div>
      )}
      {!loaded && !error && (
        <div className="flex items-center justify-center h-[400px]">
          <p className="text-zinc-500 text-sm animate-pulse">Loading session replay...</p>
        </div>
      )}
      <div ref={containerRef} className={loaded ? "" : "hidden"} />
    </div>
  );
}
