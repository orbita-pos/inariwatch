"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Link2, Check, ChevronDown, MessageSquare } from "lucide-react";
import { TimelineCanvas, DEFAULT_TRACKS, type TimelineEvent, type Chapter, type UiCausalChain, type TrackDef, type FrustrationMarker } from "./timeline-canvas";
import { formatMs } from "./format-time";
import { deriveDetailedEvents } from "./derive-detailed-events";
import { SidePanels } from "./panels/side-panels";
import { BreadcrumbStrip } from "./breadcrumb-strip";
import { ShortcutsModal } from "./shortcuts-modal";
import { findPrevEventIndex, findNextEventIndex } from "./frame-scrub";
import type { CommentRow } from "./panels/comments-panel";

/**
 * Read the initial ?t=MS query param on mount — pre-seeks the player when
 * someone shares a URL like `/replays/abc?t=12500`. Returns 0 when the
 * param is missing or malformed. Clamped to non-negative; the real upper
 * bound is enforced by `seek()` once we know the session's duration.
 */
function readInitialTimestamp(): number {
  if (typeof window === "undefined") return 0;
  const raw = new URLSearchParams(window.location.search).get("t");
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Cap at 24h — anything higher is almost certainly garbage / an attack.
  return Math.min(n, 24 * 60 * 60 * 1000);
}

// Phase C: append a 6th track for SPA navigation events. Kept here (not
// in timeline-canvas) so existing default callers keep the original 5-track
// look without surprise.
const TRACKS_WITH_NAV: TrackDef[] = [
  ...DEFAULT_TRACKS,
  { id: "nav", label: "Nav", color: "#f472b6" }, // pink-400
];

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
  rageClicks?: { timestamp: number; selector: string; count: number }[];
  deadClicks?: { timestamp: number; selector: string; mutationsAfter: number }[];
  frustrationScore?: number;
  /** Phase F — null when the host page never set window.__INARIWATCH_USER__. */
  endUser?: { id: string | null; email: string | null; emailHash: string | null } | null;
  /** Phase G — empty object when no vitals were observed (headless / Node). */
  webVitals?: Record<string, { value: number; rating: "good" | "needs-improvement" | "poor" }>;
  /** Phase I.c — pre-parsed errors with stack frames for the Errors panel. */
  resolvedErrors?: unknown[];
  /** Phase I.c — linked GitHub repo for building "open source" links. */
  repo?: { githubOwner: string; githubRepo: string; defaultBranch: string } | null;
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
  /** Day 4 — passed from the server page so the comments panel can flag
   *  the viewer's own comments (Delete button) without an extra fetch. */
  currentUserId?: string | null;
}

const SPEEDS = [1, 2, 4, 8] as const;

export function PlayerV2({ sessionId, currentUserId = null }: PlayerV2Props) {
  const [loadState, setLoadState] = useState<LoadState>("loading-manifest");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [events, setEvents] = useState<unknown[]>([]);
  // True once rrweb has rebuilt the full DOM snapshot inside the iframe.
  // Until then we overlay a spinner on the viewport so users don't stare at
  // a blank area wondering if the app froze.
  const [playerPainted, setPlayerPainted] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  // The timestamp from ?t= on the initial URL. Applied once the player has
  // painted its first frame. Read at mount because we don't want hot-link
  // jumps every time React re-renders the component.
  const [pendingSeekMs] = useState<number>(() => readInitialTimestamp());
  const [shareCopied, setShareCopied] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Day 4 — comments lifted here so both the panel and the timeline canvas
  // markers consume one source of truth (and one initial fetch).
  const [comments, setComments] = useState<CommentRow[]>([]);
  // Share PRO — inline compose-and-share popover below the Share button.
  const [sharePopoverOpen, setSharePopoverOpen] = useState(false);
  const [shareComment, setShareComment] = useState("");
  const [sharePosting, setSharePosting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);

  const replayerRef = useRef<{ pause?: (ms?: number) => void; play?: (ms?: number) => void; setConfig?: (c: unknown) => void; destroy?: () => void; on?: (e: string, cb: (d: unknown) => void) => void } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewportFrameRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  const router = useRouter();
  const [generatingFix, setGeneratingFix] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);

  // ─ Initial comments fetch ───────────────────────────────────────────
  // Single fetch on mount; the panel's own poll loop keeps it fresh while
  // it's the active tab. We do it here (not inside the panel) so the
  // timeline-canvas markers are populated even when Comments isn't the
  // active tab.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/replay/${encodeURIComponent(sessionId)}/comments`);
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as { comments: CommentRow[] };
        if (!cancelled) setComments(data.comments ?? []);
      } catch {
        // silent — panel poll will retry
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  const commentMarkerTimestamps = useMemo(
    () => comments.filter((c) => !c.parentId).map((c) => c.timestampMs),
    [comments],
  );

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
          mouseTail: false,
          UNSAFE_replayCanvas: true,
        });
        replayerRef.current = replayer;

        // rrweb Replayer won't paint until you seek/play. BUT calling pause(0)
        // synchronously right after `new Replayer()` races the iframe's load:
        // in alpha.20 the full snapshot never lands. We wait for the `resize`
        // event (fires after meta event → iframe has dimensions → safe to seek)
        // with a timeout fallback in case it already fired.
        let initialPaused = false;
        const paintInitialFrame = () => {
          if (initialPaused || !replayerRef.current) return;
          initialPaused = true;
          // Honour ?t= on first paint so shared links land at the right
          // moment instead of jumping from 0 → t after the user sees the start.
          // pendingSeekMs is captured at mount so it's a stable closure value.
          const startAt = pendingSeekMs > 0 ? pendingSeekMs : 0;
          (replayerRef.current as { pause?: (ms?: number) => void }).pause?.(startAt);
          setCurrentMs(startAt);
          setPlayerPainted(true);
        };
        replayer?.on?.("resize", paintInitialFrame);
        replayer?.on?.("fullsnapshot-rebuilded", paintInitialFrame);
        // Note: we deliberately do NOT update captureSize on rrweb's
        // subsequent `resize` events (meta events from checkoutEveryNms
        // disagree with the initial snapshot and would make the replay
        // visibly jump mid-playback). CSS overflow handles any mismatch.

        // Belt-and-suspenders: if neither event fires within 500ms, paint anyway.
        setTimeout(paintInitialFrame, 500);
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
      setPlayerPainted(false);
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

  // ─ Sync ?t= in the URL with the current playback position ─────────────
  // Throttled to once per second AND only updates when the user pauses or
  // seeks — we don't spam history while they scrub or watch at 1x. Uses
  // replaceState (not pushState) so the back button still returns to the
  // list page instead of walking through every timestamp.
  useEffect(() => {
    if (!playerPainted) return;
    if (typeof window === "undefined") return;
    const t = setTimeout(() => {
      try {
        const url = new URL(window.location.href);
        const rounded = Math.max(0, Math.round(currentMs));
        // Omit ?t= entirely at 0 so a fresh share from the start has a clean URL.
        if (rounded === 0) url.searchParams.delete("t");
        else url.searchParams.set("t", String(rounded));
        const next = `${url.pathname}${url.search}${url.hash}`;
        if (next !== window.location.pathname + window.location.search + window.location.hash) {
          window.history.replaceState(null, "", next);
        }
      } catch {
        // URL build failed — swallow, sharing is best-effort.
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [currentMs, playerPainted]);

  // ─ Poll rrweb's current time while playing ──────────────────────────────
  // rrweb v2 renamed / changed the `event-cast` payload so we can't rely on
  // events for time updates. Instead, when `playing` flips true, we spin a
  // requestAnimationFrame loop that reads the Replayer's internal time via
  // its public `getCurrentTime()` method.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const r = replayerRef.current as { getCurrentTime?: () => number } | null;
      if (r?.getCurrentTime) {
        const t = r.getCurrentTime();
        if (typeof t === "number" && Number.isFinite(t)) {
          setCurrentMs(t);
          // Auto-pause at the end — rrweb doesn't always stop itself cleanly
          const dur = manifest?.durationMs ?? 0;
          if (dur > 0 && t >= dur) {
            (replayerRef.current as { pause?: () => void } | null)?.pause?.();
            setPlaying(false);
            return;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, manifest?.durationMs]);

  // ─ Keyboard shortcuts ────────────────────────────────────────────────────
  // The frame-scrub helpers (`seekToPrevEvent` / `seekToNextEvent`) are
  // declared further down because they depend on `timelineEvents` (which
  // is also declared further down). We bridge via refs so the keyboard
  // listener has stable references without a circular hook order.
  const seekToPrevEventRef = useRef<() => void>(() => {});
  const seekToNextEventRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept when typing in an input
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

      // `?` (Shift+/) toggles the cheatsheet, ESC closes it. Handled before
      // the playback switch so they always work even while the modal is up.
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (e.key === "Escape" && shortcutsOpen) {
        setShortcutsOpen(false);
        return;
      }
      // Modal open → don't propagate playback shortcuts (would feel weird
      // if Space toggled play/pause behind the dialog).
      if (shortcutsOpen) return;

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
          // Frame-by-frame: jump to the NEXT event boundary. Falls back to
          // +100ms only when the session has zero events recorded.
          e.preventDefault();
          seekToNextEventRef.current();
          break;
        case ",":
          e.preventDefault();
          seekToPrevEventRef.current();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seek, currentMs, manifest?.durationMs, shortcutsOpen]);

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
      // SPA navs come from the capture SDK (history.pushState patch) — see
      // capture-replay/src/replay.ts attachNavWatcher. rrweb meta events
      // (type=4) also carry an href and we promote those too so the initial
      // page entry shows up as a chip even before any pushState fires.
      if (e._kind === "nav") { out.push({ timestamp: ts, kind: "nav" }); continue; }
      if (e.type === 6) { out.push({ timestamp: ts, kind: "console" }); continue; }
      if (e.type === 4) { out.push({ timestamp: ts, kind: "nav" }); continue; }
      if (e.type === 3 || e.type === 2) out.push({ timestamp: ts, kind: "dom" });
    }
    return out;
  }, [events, manifest]);

  const errorMarkers = useMemo(
    () => timelineEvents.filter((e) => e.kind === "error").map((e) => e.timestamp),
    [timelineEvents],
  );

  // Frame-by-frame scrub — sorted unique timestamps so `,` / `.` jump to
  // the previous / next event boundary instead of a fixed 100ms tick.
  // 100ms steps are wasteful in this domain: most replays alternate dense
  // bursts of events with seconds of quiet, so reviewers want "next thing
  // that happened" not "+0.1s from now".
  const eventTimestamps = useMemo<number[]>(() => {
    const set = new Set<number>();
    for (const e of timelineEvents) set.add(Math.round(e.timestamp));
    return Array.from(set).sort((a, b) => a - b);
  }, [timelineEvents]);

  const seekToPrevEvent = useCallback(() => {
    const list = eventTimestamps;
    if (list.length === 0) { seek(Math.max(0, currentMs - 100)); return; }
    const idx = findPrevEventIndex(list, currentMs);
    seek(idx === -1 ? 0 : list[idx]);
  }, [eventTimestamps, currentMs, seek]);

  const seekToNextEvent = useCallback(() => {
    const list = eventTimestamps;
    const dur = manifest?.durationMs ?? 0;
    if (list.length === 0) { seek(Math.min(dur, currentMs + 100)); return; }
    const idx = findNextEventIndex(list, currentMs);
    seek(idx === -1 ? dur : list[idx]);
  }, [eventTimestamps, currentMs, manifest?.durationMs, seek]);

  // Keep the refs the keyboard handler uses in sync with the latest closures.
  useEffect(() => { seekToPrevEventRef.current = seekToPrevEvent; }, [seekToPrevEvent]);
  useEffect(() => { seekToNextEventRef.current = seekToNextEvent; }, [seekToNextEvent]);

  // Full-metadata event stream for side panels (Console, Network, Nav).
  // Parallel to `timelineEvents` so the canvas render loop doesn't pay
  // the cost of carrying message/url/status for every event. Pure — see
  // `derive-detailed-events.ts` for the transformation + unit tests.
  const detailedEvents = useMemo(() => {
    if (!manifest) return [];
    return deriveDetailedEvents(events, new Date(manifest.startedAt).getTime());
  }, [events, manifest]);

  /**
   * Dimensions rrweb renders content at. Derived from the LARGEST meta
   * event (rrweb type 4) in the stream — and updated dynamically when
   * rrweb fires its `resize` event during playback, because rrweb itself
   * resizes its iframe whenever a subsequent meta arrives (checkoutEveryNms
   * emits fresh meta events mid-stream with potentially different dims).
   *
   * Initial seed from events: start with the LARGEST width we find. rrweb
   * will resize to the current meta as it plays; we track that live.
   */
  const [captureSize, setCaptureSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    // Seed from the largest meta event in the stream (more robust than
    // just the first — avoids the scale jumping on playback if the first
    // meta is smaller than a later one).
    let best: { w: number; h: number } | null = null;
    for (const raw of events) {
      const e = raw as { type?: number; data?: { width?: number; height?: number } };
      if (e.type === 4 && e.data?.width && e.data?.height) {
        if (!best || e.data.width * e.data.height > best.w * best.h) {
          best = { w: e.data.width, h: e.data.height };
        }
      }
    }
    if (best) setCaptureSize(best);
  }, [events]);

  /**
   * CSS-scale the viewport to fit the available space. rrweb doesn't scale
   * its iframe natively (and its `resize()` method actually crops content),
   * so we compute the scale in JS and apply a `transform: scale()` on the
   * wrapper. ResizeObserver re-runs on container resize.
   */
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!captureSize || !viewportFrameRef.current) return;
    const frame = viewportFrameRef.current;
    const compute = () => {
      const parent = frame.parentElement;
      if (!parent) return;
      const availW = parent.clientWidth;
      const availH = parent.clientHeight;
      if (availW <= 0 || availH <= 0) return;
      // Fit: pick the smaller scale so content fits fully in both axes
      const s = Math.min(availW / captureSize.w, availH / captureSize.h, 1);
      setScale(s);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(frame.parentElement!);
    return () => ro.disconnect();
  }, [captureSize]);

  const aiData = useMemo(() => extractChaptersFromManifest(manifest?.aiChapters ?? null), [manifest?.aiChapters]);

  // Phase E — flatten rage + dead clicks into a single marker array for the
  // canvas. Both arrays carry session-relative timestamps from the analyzer.
  const frustrationMarkers = useMemo<FrustrationMarker[]>(() => {
    const out: FrustrationMarker[] = [];
    for (const r of manifest?.rageClicks ?? []) {
      out.push({ ts: r.timestamp, kind: "rage", selector: r.selector });
    }
    for (const d of manifest?.deadClicks ?? []) {
      out.push({ ts: d.timestamp, kind: "dead", selector: d.selector });
    }
    return out;
  }, [manifest?.rageClicks, manifest?.deadClicks]);

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

  // ─ Share at timestamp ─────────────────────────────────────────────────
  // Copy the current URL (already includes ?t= via the sync effect) to the
  // clipboard. The 1.5s "Copied!" feedback is visible enough without being
  // annoying. Falls back silently if clipboard API blocked (cross-origin
  // iframes, insecure contexts) — the URL is still in the address bar so
  // power users can copy manually.
  const sharePlayhead = useCallback(async () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const rounded = Math.max(0, Math.round(currentMs));
    if (rounded === 0) url.searchParams.delete("t");
    else url.searchParams.set("t", String(rounded));
    try {
      await navigator.clipboard.writeText(url.toString());
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1500);
    } catch {
      // best-effort — clipboard may be blocked
    }
  }, [currentMs]);

  // Share PRO — comment + copy link in one action. Posts the comment
  // anchored to the current playhead, refreshes the panel's data, then
  // copies the URL. Keeps the popover open during the network call so
  // the user sees feedback (button disabled + "Posting…").
  const shareWithComment = useCallback(async () => {
    const text = shareComment.trim();
    if (!text || sharePosting) return;
    setSharePosting(true);
    try {
      const r = await fetch(`/api/replay/${encodeURIComponent(sessionId)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text, timestampMs: Math.round(currentMs) }),
      });
      if (r.ok) {
        // Refresh the in-memory list so markers + panel show the new one
        const list = await fetch(`/api/replay/${encodeURIComponent(sessionId)}/comments`);
        if (list.ok) {
          const data = (await list.json()) as { comments: CommentRow[] };
          setComments(data.comments ?? []);
        }
      }
    } finally {
      setSharePosting(false);
      setShareComment("");
      setSharePopoverOpen(false);
      // Always copy the link — that's the user's intent regardless of
      // whether the comment POST succeeded.
      void sharePlayhead();
    }
  }, [shareComment, sharePosting, sessionId, currentMs, sharePlayhead]);

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

        {/* Phase F — end-user pill + "show all sessions" deep link. The
            link uses endUserId when available (exact match index in DB);
            falls back to email when the SDK only sent that. Hash-only is
            display-only because there's no inverse lookup. */}
        {manifest?.endUser && (() => {
          const u = manifest.endUser!;
          const label = u.email ?? u.id ?? (u.emailHash ? `User …${u.emailHash.slice(-6)}` : null);
          if (!label) return null;
          // Prefer the dedicated /users/<id> journey page when we have a stable
          // id (Phase G). Falls back to the filtered list URL when only an
          // email or hash is available — those don't index uniquely enough
          // for a single journey view.
          const journeyHref = u.id
            ? `/replays/users/${encodeURIComponent(u.id)}`
            : u.email
              ? `/replays?endUserEmail=${encodeURIComponent(u.email)}`
              : null;
          const pill = (
            <span
              className="inline-flex max-w-[260px] items-center gap-1 truncate rounded-md bg-inari-accent/10 px-2 py-1 font-medium text-inari-accent"
              title={label}
            >
              {label}
            </span>
          );
          return (
            <div className="flex items-center gap-2 text-xs">
              {journeyHref ? (
                <a
                  href={journeyHref}
                  className="hover:underline underline-offset-2"
                  title="Open this user's session journey"
                >
                  {pill}
                </a>
              ) : (
                pill
              )}
              {journeyHref && (
                <a
                  href={journeyHref}
                  className="text-fg-base/60 underline-offset-2 hover:text-fg-base hover:underline"
                >
                  Show all sessions →
                </a>
              )}
            </div>
          );
        })()}
        <div className="flex gap-4 text-xs text-fg-base/60">
          {manifest?.browser && <span>{manifest.browser.split(" ").slice(0, 2).join(" ")}</span>}
          {manifest?.durationMs != null && <span>{formatMs(manifest.durationMs)}</span>}
          <span>{manifest?.blockCount ?? 0} blocks</span>
          <span>{Math.round((manifest?.totalBytes ?? 0) / 1024)} KB</span>
          {((manifest?.rageClicks?.length ?? 0) + (manifest?.deadClicks?.length ?? 0)) > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-500"
              title="Frustration signals detected — see red squares on the DOM track"
            >
              {(manifest?.rageClicks?.length ?? 0) > 0 && <span>{manifest!.rageClicks!.length} rage</span>}
              {(manifest?.rageClicks?.length ?? 0) > 0 && (manifest?.deadClicks?.length ?? 0) > 0 && <span>·</span>}
              {(manifest?.deadClicks?.length ?? 0) > 0 && <span>{manifest!.deadClicks!.length} dead</span>}
            </span>
          )}
          {/* Phase G — Web Vitals chips. One per metric with rating-coloured
              background. Hidden when the session has no vitals (server,
              headless, Node, very short sessions). */}
          {manifest?.webVitals && Object.keys(manifest.webVitals).length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              {(["LCP", "INP", "CLS", "FCP", "TTFB"] as const).map((name) => {
                const v = manifest.webVitals?.[name];
                if (!v) return null;
                const tone =
                  v.rating === "good"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : v.rating === "needs-improvement"
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      : "border-red-500/40 bg-red-500/10 text-red-500";
                const display = name === "CLS" ? v.value.toFixed(2) : `${Math.round(v.value)}ms`;
                return (
                  <span
                    key={name}
                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
                    title={`${name} = ${display} (${v.rating})`}
                  >
                    <span className="opacity-70">{name}</span>
                    <span className="tabular-nums">{display}</span>
                  </span>
                );
              })}
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {fixError && (
            <span className="text-xs text-red-500 max-w-[300px] truncate" title={fixError}>
              {fixError}
            </span>
          )}

          {/* Share at timestamp — split button. Left half copies the link
              instantly; right chevron opens "Comment + share" composer.
              The URL synced into the address bar already has ?t=<currentMs>
              so the copy is as cheap as `clipboard.writeText(location.href)`. */}
          <div className="relative inline-flex">
            <button
              type="button"
              onClick={sharePlayhead}
              title={`Copy link to this moment (${formatMs(currentMs)})`}
              aria-label="Copy share link with current timestamp"
              className="inline-flex items-center gap-1.5 rounded-l-md border border-r-0 border-line px-2.5 py-1.5 text-xs text-fg-base/70 hover:text-fg-base hover:border-line-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/40"
            >
              {shareCopied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                  <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
                </>
              ) : (
                <>
                  <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Share at {formatMs(currentMs)}</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => setSharePopoverOpen((v) => !v)}
              aria-label="Comment and share"
              aria-expanded={sharePopoverOpen}
              className="inline-flex items-center justify-center rounded-r-md border border-line px-1.5 text-fg-base/70 hover:text-fg-base hover:border-line-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/40"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${sharePopoverOpen ? "rotate-180" : ""}`} aria-hidden="true" />
            </button>

            {sharePopoverOpen && (
              <div
                role="dialog"
                aria-label="Comment and share"
                className="absolute right-0 top-[calc(100%+4px)] z-30 w-72 rounded-lg border border-line bg-surface p-2 shadow-lg"
              >
                <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-base/50">
                  <MessageSquare className="h-3 w-3" aria-hidden="true" />
                  Comment + share at {formatMs(currentMs)}
                </div>
                <textarea
                  value={shareComment}
                  onChange={(e) => setShareComment(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void shareWithComment();
                    }
                    if (e.key === "Escape") setSharePopoverOpen(false);
                  }}
                  rows={3}
                  autoFocus
                  placeholder="What should your team see here? Use @email to ping a teammate."
                  className="w-full resize-none rounded-md border border-line bg-surface-inner px-2 py-1.5 text-xs text-fg-base placeholder:text-fg-base/40 focus:outline-none focus:border-inari-accent"
                />
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-fg-base/40">Cmd/Ctrl+Enter to post</span>
                  <button
                    type="button"
                    onClick={() => void shareWithComment()}
                    disabled={sharePosting || shareComment.trim().length === 0}
                    className="inline-flex items-center gap-1 rounded-md bg-inari-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {sharePosting ? "Posting…" : "Post & copy link"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {hasErrors && (
            <button
              type="button"
              onClick={generateFix}
              disabled={generatingFix}
              className="px-3 py-1.5 rounded-md bg-inari-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generatingFix ? "Starting…" : "🔧 Generate Fix"}
            </button>
          )}
        </div>
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
        <button
          type="button"
          onClick={() => setShortcutsOpen(true)}
          aria-label="Show keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-md border border-line px-1.5 text-[11px] font-mono text-fg-base/50 hover:text-fg-base hover:border-line-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/40"
        >
          <kbd className="font-mono">?</kbd>
          <span className="hidden sm:inline text-fg-base/40">shortcuts</span>
        </button>
      </div>

      {/* Breadcrumb strip — horizontal chips of URLs visited with dwell times.
          Hidden gracefully (returns null) when the session has no nav events. */}
      <BreadcrumbStrip
        events={detailedEvents}
        currentMs={currentMs}
        onSeek={seek}
        durationMs={duration}
      />

      {/* Viewport row: rrweb canvas on the left, side panels on the right.
          The flex-1 row must have `min-h-0` so the viewport flex child can
          actually shrink; without it, canvas content overflows vertically.
          rrweb reads its parent's `clientWidth` via ResizeObserver, so
          expanding/collapsing panels re-fires the scale compute for free. */}
      <div className="flex flex-1 min-h-0">
        {/* rrweb viewport — renders at the captured page's natural size
            (from the META event), then we CSS-scale the whole thing to fit.
            rrweb's own `resize()` method crops content (changes iframe
            width without scaling), so we MUST scale client-side. */}
        <div className="relative flex-1 flex items-center justify-center bg-zinc-950 overflow-hidden min-h-0">
          <div
            ref={viewportFrameRef}
            className="relative w-full h-full flex items-center justify-center overflow-hidden"
          >
            <div
              style={{
                transform: `scale(${scale})`,
                transformOrigin: "center center",
                flexShrink: 0,
              }}
            >
              <div
                ref={viewportRef}
                className="inariwatch-replay-root"
                style={{
                  position: "relative",
                  isolation: "isolate",
                  width: captureSize?.w ?? 1024,
                  height: captureSize?.h ?? 576,
                  background: "#fff",
                  overflow: "hidden",
                }}
              />
              {/* Lock rrweb's iframe + wrapper to fill our root. rrweb
                  sometimes changes the iframe's width attribute mid-stream
                  (when a new meta event arrives with different dims from
                  checkoutEveryNms). !important keeps the visual stable. */}
              <style dangerouslySetInnerHTML={{ __html: `
                .inariwatch-replay-root .replayer-wrapper,
                .inariwatch-replay-root .replayer-wrapper iframe,
                .inariwatch-replay-root > iframe {
                  width: 100% !important;
                  height: 100% !important;
                  border: 0 !important;
                }
              `}} />
            </div>
          </div>

          {/* Loading overlay until rrweb paints the first frame. */}
          {!playerPainted && events.length > 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950/90 pointer-events-none">
              <div className="h-8 w-8 rounded-full border-2 border-inari-accent border-t-transparent animate-spin" />
              <p className="text-xs text-fg-base/60 font-mono">
                Rebuilding DOM snapshot…
              </p>
            </div>
          )}
        </div>

        {/* Side panels — tabbed (Console | Network), collapsible, persist
            active tab + collapsed state in localStorage */}
        <SidePanels
          events={detailedEvents}
          currentMs={currentMs}
          onSeek={seek}
          errors={(manifest?.resolvedErrors ?? []) as Parameters<typeof SidePanels>[0]["errors"]}
          repo={manifest?.repo ?? null}
          sessionId={sessionId}
          comments={comments}
          onCommentsChange={setComments}
          currentUserId={currentUserId}
        />
      </div>

      {/* Multi-track timeline */}
      <TimelineCanvas
        duration={duration}
        currentMs={currentMs}
        events={timelineEvents}
        chapters={aiData.chapters}
        errorMarkers={errorMarkers}
        frustrationMarkers={frustrationMarkers}
        commentMarkers={commentMarkerTimestamps}
        causalChains={aiData.chains}
        onSeek={seek}
        tracks={TRACKS_WITH_NAV}
      />

      {/* AI summary (if present) */}
      {manifest?.aiSummary && (
        <div className="px-8 py-3 border-t border-line bg-surface text-sm text-fg-base/80 max-h-32 overflow-y-auto">
          <span className="text-inari-accent font-medium">Inari:</span> {manifest.aiSummary}
        </div>
      )}

      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
