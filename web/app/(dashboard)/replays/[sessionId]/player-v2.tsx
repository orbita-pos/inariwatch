"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { TimelineCanvas, type TimelineEvent, type Chapter, type UiCausalChain } from "./timeline-canvas";
import { formatMs } from "./format-time";

interface SignedBlock {
  index: number;
  startMs: number;
  endMs: number;
  url: string;
}

interface Manifest {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  browser: string | null;
  os: string | null;
  viewport: { width?: number; height?: number; dpr?: number } | null;
  alertId: string | null;
  projectId: string | null;
  organizationId: string;
  blockCount: number;
  totalBytes: number;
  clickSelectors: string[];
  urlsVisited: string[];
  errorFingerprints: string[];
  aiSummary: string | null;
  /**
   * Phase 2+ shape: { chapters, chains }. Older sessions may still have a raw
   * Chapter[] — `extractChaptersFromManifest` handles both.
   */
  aiChapters: { chapters?: Chapter[]; chains?: UiCausalChain[] } | Chapter[] | null;
  blocks: SignedBlock[];
}

function extractChaptersFromManifest(ai: Manifest["aiChapters"]): { chapters: Chapter[]; chains: UiCausalChain[] } {
  if (!ai) return { chapters: [], chains: [] };
  if (Array.isArray(ai)) return { chapters: ai, chains: [] };
  return {
    chapters: Array.isArray(ai.chapters) ? ai.chapters : [],
    chains: Array.isArray(ai.chains) ? ai.chains : [],
  };
}

type LoadState = "loading-manifest" | "loading-blocks" | "ready" | "error";

interface PlayerV2Props {
  sessionId: string;
}

const SPEEDS = [1, 2, 4, 8] as const;

export function PlayerV2({ sessionId }: PlayerV2Props) {
  const [loadState, setLoadState] = useState<LoadState>("loading-manifest");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [events, setEvents] = useState<unknown[]>([]);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);

  const replayerRef = useRef<{ pause?: (ms?: number) => void; play?: (ms?: number) => void; setConfig?: (c: unknown) => void; destroy?: () => void; on?: (e: string, cb: (d: unknown) => void) => void } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  const router = useRouter();
  const [generatingFix, setGeneratingFix] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);

  // ─ Load manifest ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`/api/replay/${encodeURIComponent(sessionId)}/manifest`);
        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`${resp.status}: ${body.slice(0, 200)}`);
        }
        const data: Manifest = await resp.json();
        if (!cancelled) {
          setManifest(data);
          setLoadState("loading-blocks");
        }
      } catch (e) {
        if (!cancelled) {
          setErrorMsg(e instanceof Error ? e.message : "Failed to load manifest");
          setLoadState("error");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  // ─ Stream blocks ─────────────────────────────────────────────────────────
  // Strategy for MVP: parallel-fetch the first 3 blocks, then lazy-load the
  // rest when the scrubber approaches them. For Phase 1 we just fetch all
  // in parallel — sessions are typically <5 min (10 blocks).
  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    (async () => {
      try {
        const blockPayloads = await Promise.all(
          manifest.blocks.map((b) =>
            fetch(b.url).then((r) => {
              if (!r.ok) throw new Error(`Block ${b.index} fetch failed: ${r.status}`);
              return r.json();
            }),
          ),
        );
        if (cancelled) return;
        const merged = blockPayloads.flat();
        setEvents(merged);
        setLoadState("ready");
      } catch (e) {
        if (!cancelled) {
          setErrorMsg(e instanceof Error ? e.message : "Failed to load blocks");
          setLoadState("error");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [manifest]);

  // ─ Init rrweb Replayer once events are loaded ────────────────────────────
  useEffect(() => {
    if (loadState !== "ready" || !viewportRef.current || events.length === 0) return;
    let cancelled = false;
    let replayer: { pause?: () => void; play?: (ms?: number) => void; setConfig?: (c: unknown) => void; destroy?: () => void; on?: (e: string, cb: (d: unknown) => void) => void } | null = null;

    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await import("rrweb");
        if (cancelled) return;
        const Replayer = mod.Replayer ?? mod.default?.Replayer;
        if (!Replayer) throw new Error("rrweb.Replayer not found");
        replayer = new Replayer(events, {
          root: viewportRef.current!,
          skipInactive: true,
          showWarning: false,
          liveMode: false,
          UNSAFE_replayCanvas: true,
        });
        replayerRef.current = replayer;

        // Track time via replayer events
        replayer?.on?.("event-cast", (d) => {
          const data = d as { offset?: number };
          if (typeof data.offset === "number") setCurrentMs(data.offset);
        });
      } catch (e) {
        if (!cancelled) {
          setErrorMsg(e instanceof Error ? e.message : "Failed to init replayer");
          setLoadState("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      replayer?.destroy?.();
      replayerRef.current = null;
      if (viewportRef.current) viewportRef.current.innerHTML = "";
    };
  }, [loadState, events]);

  // ─ Controls ──────────────────────────────────────────────────────────────
  const seek = useCallback((ms: number) => {
    const clamped = Math.max(0, Math.min(manifest?.durationMs ?? ms, ms));
    setCurrentMs(clamped);
    const r = replayerRef.current;
    if (!r) return;
    if (playing) r.play?.(clamped);
    else r.pause?.(clamped);
  }, [manifest?.durationMs, playing]);

  const togglePlay = useCallback(() => {
    const r = replayerRef.current;
    if (!r) return;
    if (playing) {
      r.pause?.();
      setPlaying(false);
    } else {
      r.play?.(currentMs);
      setPlaying(true);
    }
  }, [playing, currentMs]);

  const changeSpeed = useCallback((s: (typeof SPEEDS)[number]) => {
    setSpeed(s);
    replayerRef.current?.setConfig?.({ speed: s });
  }, []);

  // ─ Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept when typing in an input
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const duration = manifest?.durationMs ?? 0;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seek(currentMs - 1000);
          break;
        case "ArrowRight":
          e.preventDefault();
          seek(currentMs + 1000);
          break;
        case "j":
          seek(currentMs - 5000);
          break;
        case "k":
          togglePlay();
          break;
        case "l":
          seek(currentMs + 5000);
          break;
        case ".":
          seek(Math.min(duration, currentMs + 100));
          break;
        case ",":
          seek(Math.max(0, currentMs - 100));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seek, currentMs, manifest?.durationMs]);

  // ─ Derive timeline events from raw rrweb + build chapters ────────────────
  const timelineEvents = useMemo<TimelineEvent[]>(() => {
    if (!manifest) return [];
    const baseTs = new Date(manifest.startedAt).getTime();
    const out: TimelineEvent[] = [];
    for (const raw of events) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as { type?: number; timestamp?: number; data?: { source?: number }; _kind?: string };
      const ts = typeof e.timestamp === "number" ? e.timestamp - baseTs : 0;
      if (e._kind === "error") { out.push({ timestamp: ts, kind: "error" }); continue; }
      if (e._kind === "network") { out.push({ timestamp: ts, kind: "network" }); continue; }
      if (e._kind === "substrate" || e._kind === "io") { out.push({ timestamp: ts, kind: "io" }); continue; }
      if (e.type === 6) { out.push({ timestamp: ts, kind: "console" }); continue; }
      if (e.type === 3 || e.type === 2 || e.type === 4) out.push({ timestamp: ts, kind: "dom" });
    }
    return out;
  }, [events, manifest]);

  const errorMarkers = useMemo(
    () => timelineEvents.filter((e) => e.kind === "error").map((e) => e.timestamp),
    [timelineEvents],
  );

  const aiData = useMemo(() => extractChaptersFromManifest(manifest?.aiChapters ?? null), [manifest?.aiChapters]);

  const hasErrors = (manifest?.errorFingerprints?.length ?? 0) > 0 || errorMarkers.length > 0;

  const generateFix = useCallback(async () => {
    if (generatingFix) return;
    setFixError(null);
    setGeneratingFix(true);
    try {
      const resp = await fetch(`/api/replay/${encodeURIComponent(sessionId)}/generate-fix`, {
        method: "POST",
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error ?? `Request failed (${resp.status})`);
      }
      if (data.dashboardUrl) {
        router.push(data.dashboardUrl);
        return;
      }
      setGeneratingFix(false);
    } catch (e) {
      setFixError(e instanceof Error ? e.message : "Failed to generate fix");
      setGeneratingFix(false);
    }
  }, [sessionId, generatingFix, router]);

  const duration = manifest?.durationMs ?? 0;

  // ─ Render states ─────────────────────────────────────────────────────────
  if (loadState === "error") {
    return (
      <div className="flex items-center justify-center h-screen bg-page">
        <div className="bg-surface border border-red-500/20 rounded-xl p-6 max-w-lg">
          <h2 className="text-lg font-semibold text-red-500 mb-2">Replay failed to load</h2>
          <p className="text-sm text-fg-base/70">{errorMsg}</p>
        </div>
      </div>
    );
  }

  if (loadState === "loading-manifest" || loadState === "loading-blocks") {
    return (
      <div className="flex items-center justify-center h-screen bg-page">
        <p className="text-sm text-fg-base/60 animate-pulse">
          {loadState === "loading-manifest" ? "Loading manifest..." : `Loading ${manifest?.blockCount ?? 0} blocks...`}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-page">
      {/* Header */}
      <div className="flex items-center gap-4 px-8 py-4 border-b border-line bg-surface">
        <h1 className="text-lg font-semibold text-fg-strong">
          <span className="text-inari-accent">Replay</span> {sessionId.slice(0, 12)}…
        </h1>
        <div className="flex gap-4 text-xs text-fg-base/60">
          {manifest?.browser && <span>{manifest.browser.split(" ").slice(0, 2).join(" ")}</span>}
          {manifest?.durationMs != null && <span>{formatMs(manifest.durationMs)}</span>}
          <span>{manifest?.blockCount ?? 0} blocks</span>
          <span>{Math.round((manifest?.totalBytes ?? 0) / 1024)} KB</span>
        </div>

        {hasErrors && (
          <div className="ml-auto flex items-center gap-3">
            {fixError && (
              <span className="text-xs text-red-500 max-w-[300px] truncate" title={fixError}>
                {fixError}
              </span>
            )}
            <button
              type="button"
              onClick={generateFix}
              disabled={generatingFix}
              className="px-3 py-1.5 rounded-md bg-inari-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generatingFix ? "Starting…" : "🔧 Generate Fix"}
            </button>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 px-8 py-2 border-b border-line bg-surface-inner">
        <button
          type="button"
          onClick={togglePlay}
          className="w-9 h-9 rounded-full bg-inari-accent text-white flex items-center justify-center hover:opacity-90"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <span className="font-mono text-sm tabular-nums text-fg-base">
          {formatMs(currentMs)} / {formatMs(duration)}
        </span>
        <div className="flex items-center gap-1 ml-4">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => changeSpeed(s)}
              aria-pressed={speed === s}
              className={`text-xs px-2 py-1 rounded ${
                speed === s ? "bg-inari-accent text-white" : "text-fg-base/60 hover:text-fg-base"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-fg-base/40">
          Space = play/pause · ←/→ = 1s · J/L = 5s · ./, = frame
        </span>
      </div>

      {/* rrweb viewport */}
      <div className="flex-1 flex items-center justify-center bg-zinc-950 overflow-hidden">
        <div
          ref={viewportRef}
          className="w-full h-full relative"
          style={{ isolation: "isolate" }}
        />
      </div>

      {/* Multi-track timeline */}
      <TimelineCanvas
        duration={duration}
        currentMs={currentMs}
        events={timelineEvents}
        chapters={aiData.chapters}
        errorMarkers={errorMarkers}
        causalChains={aiData.chains}
        onSeek={seek}
      />

      {/* AI summary (if present) */}
      {manifest?.aiSummary && (
        <div className="px-8 py-3 border-t border-line bg-surface text-sm text-fg-base/80 max-h-32 overflow-y-auto">
          <span className="text-inari-accent font-medium">Inari:</span> {manifest.aiSummary}
        </div>
      )}
    </div>
  );
}
