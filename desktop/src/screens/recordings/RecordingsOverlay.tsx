import {
  ArrowRight,
  Check,
  ChevronDown as LucideChevronDown,
  KeyRound,
  Play,
  X,
} from "lucide-react";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { InariMark } from "@/screens/MainWindow";

/**
 * Recordings viewer — 2026-05-08 design pivot (Section 3 of Bundle 4).
 *
 * Two surfaces inside one overlay:
 *
 *   - **List**: titlebar + filter strip + 2-line rows showing
 *     timestamp, session title, turn / tool count, duration, sage
 *     chain-root chip. Selected row reveals a "Replay" CTA on the
 *     right.
 *   - **Player**: 60% chat replay (with the current turn glowing) +
 *     40% timeline scrubber with markers (assistant prose / tool
 *     calls / user turns) + bottom strip with playback speed,
 *     chapters, and Verify chain → CTA.
 *
 * Witness-replayer IPC isn't wired yet — the surface ships with
 * deterministic mock data so Jesus can review the visuals; Phase B
 * will swap the data source for `desktop_replay_list` /
 * `desktop_replay_load`.
 */

export interface RecordingsOverlayProps {
  open: boolean;
  onClose: () => void;
}

interface RecordingRow {
  id: string;
  startedAt: number;
  title: string;
  turnCount: number;
  toolCallCount: number;
  durationMs: number;
  sessionId: string;
  chainRoot: string;
}

const MOCK_RECORDINGS: RecordingRow[] = [
  {
    id: "rec_1",
    startedAt: Date.parse("2026-05-08T02:18:14Z"),
    title: "debugging auth jwt panic",
    turnCount: 8,
    toolCallCount: 14,
    durationMs: 4 * 60_000 + 12_000,
    sessionId: "abc123f4",
    chainRoot: "root_4187_ea66201",
  },
  {
    id: "rec_2",
    startedAt: Date.parse("2026-05-07T19:32:08Z"),
    title: "vercel deploy timeout — rollback",
    turnCount: 5,
    toolCallCount: 9,
    durationMs: 2 * 60_000 + 47_000,
    sessionId: "9f2b1a07",
    chainRoot: "root_4172_b30c129",
  },
  {
    id: "rec_3",
    startedAt: Date.parse("2026-05-06T14:10:33Z"),
    title: "RDS replica lag investigation",
    turnCount: 12,
    toolCallCount: 23,
    durationMs: 7 * 60_000 + 19_000,
    sessionId: "5e8b2f1c",
    chainRoot: "root_4109_cd44a01",
  },
  {
    id: "rec_4",
    startedAt: Date.parse("2026-05-04T22:01:45Z"),
    title: "code intel reindex + spike",
    turnCount: 4,
    toolCallCount: 11,
    durationMs: 3 * 60_000 + 8_000,
    sessionId: "7a44ee19",
    chainRoot: "root_4023_f4c0e91",
  },
];

interface TimelineMarker {
  id: string;
  timestamp: string;
  kind: "user" | "assistant" | "tool";
  label: string;
  witnessHash?: string;
}

const MOCK_MARKERS: TimelineMarker[] = [
  { id: "m1", timestamp: "00:00:04", kind: "user", label: "Why did the auth pod crash at 02:14?" },
  { id: "m2", timestamp: "00:00:12", kind: "assistant", label: "diagnosed TypeError in decodeJwt" },
  { id: "m3", timestamp: "00:00:48", kind: "tool", label: "search.error_context", witnessHash: "w_5e8b2f1" },
  { id: "m4", timestamp: "00:01:23", kind: "tool", label: "local_exec.read_file", witnessHash: "w_d12f4a0" },
  { id: "m5", timestamp: "00:02:11", kind: "user", label: "Patch it." },
  { id: "m6", timestamp: "00:02:18", kind: "assistant", label: "proposed fix + diff card" },
  { id: "m7", timestamp: "00:02:54", kind: "tool", label: "git.apply_diff", witnessHash: "w_8a02b14c" },
  { id: "m8", timestamp: "00:04:12", kind: "assistant", label: "post-merge confirmation" },
];

export function RecordingsOverlay({ open, onClose }: RecordingsOverlayProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
    }
  }, [open]);

  if (!open) return null;

  const selectedRecording = MOCK_RECORDINGS.find((r) => r.id === selectedId);

  return (
    <div
      data-testid="recordings-overlay"
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--bg)" }}
    >
      {selectedRecording ? (
        <ReplayPlayer
          recording={selectedRecording}
          onBack={() => setSelectedId(null)}
          onClose={onClose}
        />
      ) : (
        <RecordingsList
          recordings={MOCK_RECORDINGS}
          onPick={setSelectedId}
          onClose={onClose}
        />
      )}
    </div>
  );
}

// ── List ────────────────────────────────────────────────────────────────────

interface RecordingsListProps {
  recordings: RecordingRow[];
  onPick: (id: string) => void;
  onClose: () => void;
}

function RecordingsList({ recordings, onPick, onClose }: RecordingsListProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    recordings.length > 0 ? recordings[0]!.id : null,
  );
  const oldestAge = useMemo(() => {
    if (recordings.length === 0) return null;
    const oldest = recordings.reduce((a, b) => (a.startedAt < b.startedAt ? a : b));
    return formatRelativeAge(oldest.startedAt);
  }, [recordings]);

  return (
    <>
      <header
        className="flex items-center gap-3 shrink-0"
        style={{
          height: 44,
          padding: "0 16px",
          borderBottom: "1px solid var(--border)",
          background: "linear-gradient(180deg, rgba(255,255,255,0.012), transparent)",
        }}
      >
        <InariMark size={18} />
        <span style={{ fontSize: 16 }}>📼</span>
        <span
          className="text-[13.5px]"
          style={{ color: "var(--text)", fontWeight: 500 }}
        >
          Recordings
        </span>
        <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
          {recordings.length} session{recordings.length === 1 ? "" : "s"}
          {oldestAge ? ` · oldest ${oldestAge}` : ""}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close recordings"
          data-testid="recordings-close"
          className="ml-auto transition-colors"
          style={{ color: "var(--text-subtle)" }}
        >
          <X size={14} strokeWidth={1.6} />
        </button>
      </header>

      {/* Filter strip — single date chip + search input */}
      <div
        className="flex items-center gap-2 shrink-0"
        style={{
          padding: "10px 18px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <button
          type="button"
          className="inline-flex items-center gap-1.5 transition-colors hover:bg-white/[0.02]"
          style={{
            height: 28,
            padding: "0 11px",
            borderRadius: 999,
            border: "1px solid var(--border)",
            color: "var(--text-subtle)",
            fontSize: 12,
          }}
        >
          <CalendarIcon />
          Last 7 days
          <ChevronDown />
        </button>
        <input
          type="search"
          placeholder="Search sessions…"
          className="outline-none"
          style={{
            height: 28,
            padding: "0 10px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            fontSize: 12,
            color: "var(--text-muted)",
            width: 200,
          }}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {recordings.length === 0 ? (
          <div
            className="px-6 py-12 text-center text-[12.5px]"
            style={{ color: "var(--text-subtle)" }}
          >
            No recordings yet. Start one from{" "}
            <span style={{ color: "var(--text-muted)" }}>Settings → Privacy</span>.
          </div>
        ) : (
          <ul role="list">
            {recordings.map((rec) => (
              <RecordingRowItem
                key={rec.id}
                recording={rec}
                selected={selectedId === rec.id}
                onSelect={() => setSelectedId(rec.id)}
                onReplay={() => onPick(rec.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <footer
        className="flex items-center gap-3 shrink-0"
        style={{
          height: 34,
          padding: "0 18px",
          borderTop: "1px solid var(--border)",
          fontSize: 10.5,
          fontFamily: "var(--font-mono)",
          color: "var(--text-dim)",
        }}
      >
        <span>⌘⇧R open</span>
        <span style={{ color: "var(--text-faint)" }}>·</span>
        <span>⏎ replay</span>
        <span style={{ color: "var(--text-faint)" }}>·</span>
        <span>esc close</span>
      </footer>
    </>
  );
}

function CalendarIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

interface RecordingRowItemProps {
  recording: RecordingRow;
  selected: boolean;
  onSelect: () => void;
  onReplay: () => void;
}

function RecordingRowItem({
  recording,
  selected,
  onSelect,
  onReplay,
}: RecordingRowItemProps) {
  const dateTime = formatRecordingTimestamp(recording.startedAt);
  const duration = formatDuration(recording.durationMs);

  return (
    <li
      role="listitem"
      data-testid={`recording-row-${recording.id}`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onReplay();
        } else if (e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className="relative flex items-stretch cursor-default"
      style={{
        padding: "0 18px",
        height: 70,
        borderBottom: "1px solid var(--border)",
        background: selected ? "rgba(239,233,220,0.028)" : "transparent",
      }}
    >
      {selected ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            top: 10,
            bottom: 10,
            width: 2,
            background: "var(--accent)",
            borderRadius: 2,
          }}
        />
      ) : null}
      <div
        className="flex flex-col justify-center flex-1 min-w-0"
        style={{ gap: 4 }}
      >
        <span
          className="text-[11.5px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text-subtle)" }}
        >
          {dateTime}
        </span>
        <span
          className="text-[13px] truncate"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--text)",
            fontWeight: 500,
          }}
        >
          {recording.title}
        </span>
        <div className="flex items-center" style={{ gap: 12 }}>
          <span
            className="text-[11px] truncate"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--text-subtle)",
            }}
          >
            {recording.turnCount} turn{recording.turnCount === 1 ? "" : "s"} ·{" "}
            {recording.toolCallCount} tool call
            {recording.toolCallCount === 1 ? "" : "s"} · {duration} · sess{" "}
            {recording.sessionId}
          </span>
          <ChainRootChip root={recording.chainRoot} />
        </div>
      </div>
      {selected ? (
        <div className="flex items-center" style={{ flexShrink: 0, marginLeft: 14 }}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReplay();
            }}
            data-testid={`recording-replay-${recording.id}`}
            className="inline-flex items-center gap-1.5 transition-colors hover:bg-white/[0.02]"
            style={{
              height: 26,
              padding: "0 12px",
              borderRadius: 7,
              border: "1px solid var(--border-strong)",
              color: "var(--text-muted)",
              fontSize: 11.5,
            }}
          >
            <Play size={11} strokeWidth={2} fill="currentColor" />
            Replay
          </button>
        </div>
      ) : null}
    </li>
  );
}

function formatRecordingTimestamp(ms: number): string {
  const d = new Date(ms);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${month} ${day} · ${hh}:${mm}`;
}

interface ChainRootChipProps {
  root: string;
}

function ChainRootChip({ root }: ChainRootChipProps) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{
        height: 22,
        padding: "0 8px 0 7px",
        borderRadius: 999,
        background:
          "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))",
        border: "1px solid rgba(166,194,176,0.18)",
        color: "var(--verified)",
        fontSize: 11,
        lineHeight: 1,
      }}
    >
      <KeyRound size={11} strokeWidth={1.6} />
      <span style={{ color: "rgba(166,194,176,0.78)" }}>verified</span>
      <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          color: "#C8DDD0",
          letterSpacing: "0.01em",
        }}
      >
        {root}
      </span>
    </span>
  );
}

// ── Player ──────────────────────────────────────────────────────────────────

interface ReplayPlayerProps {
  recording: RecordingRow;
  onBack: () => void;
  onClose: () => void;
}

function ReplayPlayer({ recording, onBack, onClose }: ReplayPlayerProps) {
  const [activeMarkerIdx, setActiveMarkerIdx] = useState(2); // m3 highlighted

  const speedOptions = [
    { value: "0.5x", label: "0.5×" },
    { value: "1x", label: "1×" },
    { value: "2x", label: "2×" },
    { value: "4x", label: "4×" },
  ] as const;
  const [speed, setSpeed] = useState<(typeof speedOptions)[number]["value"]>("1x");

  return (
    <>
      <header
        className="flex items-center gap-2.5 px-5 shrink-0"
        style={{
          height: 44,
          borderBottom: "1px solid var(--border)",
          background: "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to list"
          data-testid="replay-back"
          className="transition-colors hover:text-[var(--text)]"
          style={{ color: "var(--text-subtle)", padding: "4px 6px" }}
        >
          ←
        </button>
        <InariMark size={14} />
        <span
          className="text-[13px] truncate"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}
        >
          {recording.title}
        </span>
        <span style={{ color: "var(--text-faint)" }} className="mx-1">·</span>
        <ChainRootChip root={recording.chainRoot} />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close recordings"
          data-testid="replay-close"
          className="ml-auto transition-colors"
          style={{ color: "var(--text-subtle)" }}
        >
          <X size={14} strokeWidth={1.7} />
        </button>
      </header>

      <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: "60% 40%" }}>
        <ChatReplayPane activeIdx={activeMarkerIdx} />
        <TimelinePane
          markers={MOCK_MARKERS}
          activeIdx={activeMarkerIdx}
          onSeek={setActiveMarkerIdx}
          duration={recording.durationMs}
        />
      </div>

      <footer
        className="flex items-center gap-3 shrink-0 flex-wrap"
        style={{
          padding: "10px 18px",
          borderTop: "1px solid var(--border)",
          background: "linear-gradient(0deg, rgba(255,255,255,0.012), rgba(255,255,255,0))",
        }}
      >
        <div
          className="inline-flex"
          role="radiogroup"
          aria-label="Playback speed"
          style={{
            background: "rgba(255,255,255,0.022)",
            border: "1px solid var(--border-strong)",
            borderRadius: 9,
            padding: 2,
            gap: 2,
          }}
        >
          {speedOptions.map((opt) => {
            const active = opt.value === speed;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setSpeed(opt.value)}
                className="transition-colors"
                style={{
                  height: 24,
                  padding: "0 9px",
                  borderRadius: 6,
                  fontSize: 11,
                  background: active ? "rgba(255,255,255,0.05)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5">
          <span
            className="text-[11.5px]"
            style={{ color: "var(--text-subtle)" }}
          >
            Jump to:
          </span>
          {(["proposed fix", "apply fix", "post-merge"] as const).map((label, i) => (
            <button
              key={label}
              type="button"
              onClick={() => setActiveMarkerIdx([1, 6, 7][i] ?? 0)}
              data-testid={`replay-chapter-${label.replace(/\s+/g, "-")}`}
              className="inline-flex items-center transition-colors hover:bg-white/[0.025]"
              style={{
                height: 22,
                padding: "0 10px",
                borderRadius: 6,
                border: "1px solid var(--border-strong)",
                color: "var(--text-muted)",
                fontSize: 11,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          data-testid="replay-verify-chain"
          className="ml-auto inline-flex items-center gap-1.5 transition-colors hover:bg-white/[0.025]"
          style={{
            height: 22,
            padding: "0 10px",
            borderRadius: 6,
            border: "1px solid rgba(166,194,176,0.34)",
            background: "transparent",
            color: "var(--verified)",
            fontSize: 11,
          }}
        >
          <KeyRound size={11} strokeWidth={1.7} />
          Verify chain
          <ArrowRight size={11} strokeWidth={1.7} />
        </button>
      </footer>
    </>
  );
}

interface ChatReplayPaneProps {
  activeIdx: number;
}

function ChatReplayPane({ activeIdx }: ChatReplayPaneProps) {
  return (
    <div
      className="overflow-auto px-8 py-10"
      style={{ borderRight: "1px solid var(--border)" }}
    >
      <div className="max-w-[600px] mx-auto space-y-7">
        <UserBubble glow={activeIdx === 0}>
          Why did the auth pod crash at 02:14?
        </UserBubble>
        <AssistantTurn glow={activeIdx === 1}>
          The pod hit a TypeError inside <Mono>decodeJwt</Mono> when a malformed
          token came in. <Mono>token.split('.')</Mono> yielded fewer than three
          segments, and the destructure on line 140 produced{" "}
          <Mono>undefined</Mono>.
        </AssistantTurn>
        <AssistantTurn glow={activeIdx === 2} witnessHash="w_5e8b2f1">
          <span style={{ color: "var(--text-muted)" }}>
            tool · search.error_context returned 7 hits (3 SO, 3 GH, 1 MDN).
          </span>
        </AssistantTurn>
      </div>
    </div>
  );
}

function UserBubble({ children, glow }: { children: ReactNode; glow: boolean }) {
  return (
    <div className="flex justify-end" data-glow={glow ? "true" : "false"}>
      <div
        className="px-4 py-2.5"
        style={{
          maxWidth: 420,
          background: "linear-gradient(180deg, #1c1c22, #181820)",
          border: glow
            ? "1px solid rgba(239,233,220,0.40)"
            : "1px solid var(--border-strong)",
          borderRadius: "14px 14px 4px 14px",
          color: "var(--text)",
          boxShadow: glow ? "0 0 0 4px rgba(166,194,176,0.08)" : undefined,
        }}
      >
        <div className="text-[14.5px]">{children}</div>
      </div>
    </div>
  );
}

interface AssistantTurnProps {
  children: ReactNode;
  glow: boolean;
  witnessHash?: string;
}

function AssistantTurn({ children, glow, witnessHash }: AssistantTurnProps) {
  return (
    <div
      data-glow={glow ? "true" : "false"}
      style={{
        padding: glow ? "12px 14px" : 0,
        borderRadius: 12,
        // The active-turn highlight stays INSIDE the turn's natural box
        // — earlier we used negative margins to pull the border outward,
        // but on close turn-spacing the top edge ate into the previous
        // turn's text. The `space-y-7` (28 px) gap from the parent
        // already gives the box enough breathing room.
        border: glow ? "1px solid rgba(239,233,220,0.30)" : "1px solid transparent",
        boxShadow: glow ? "0 0 0 4px rgba(166,194,176,0.08)" : undefined,
        background: glow ? "rgba(239,233,220,0.02)" : undefined,
      }}
    >
      <div
        className="flex items-center gap-2 mb-2"
        style={{ fontSize: 11.5, color: "var(--text-dim)" }}
      >
        <InariMark size={10} />
        <span style={{ color: "var(--text-muted)" }}>Inari</span>
      </div>
      <div
        className="text-[14.5px] leading-[1.65]"
        style={{ color: "var(--text)" }}
      >
        {children}
      </div>
      {witnessHash ? (
        <div className="mt-2.5">
          <span
            className="inline-flex items-center gap-1.5"
            style={{
              height: 20,
              padding: "0 7px",
              borderRadius: 999,
              background:
                "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))",
              border: "1px solid rgba(166,194,176,0.18)",
              color: "var(--verified)",
              fontSize: 10.5,
              lineHeight: 1,
            }}
          >
            <KeyRound size={10} strokeWidth={1.6} />
            <span style={{ color: "rgba(166,194,176,0.78)" }}>verified</span>
            <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
            <span style={{ fontFamily: "var(--font-mono)", color: "#C8DDD0" }}>
              {witnessHash}
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

interface TimelinePaneProps {
  markers: TimelineMarker[];
  activeIdx: number;
  onSeek: (idx: number) => void;
  duration: number;
}

function TimelinePane({ markers, activeIdx, onSeek, duration }: TimelinePaneProps) {
  const elapsedTimecode = markers[activeIdx]?.timestamp ?? "00:00:00";
  // Pseudo-progress: index / total. Replaces with real elapsed once
  // the witness-replayer IPC ships seek timestamps.
  const progressPct = markers.length > 0 ? Math.round(((activeIdx + 1) / markers.length) * 100) : 0;
  return (
    <div className="overflow-auto px-5 py-5">
      <div className="flex items-center gap-2.5 mb-5">
        <button
          type="button"
          aria-label="Play"
          className="inline-flex items-center justify-center"
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            border: "1px solid var(--border-strong)",
            background: "var(--surface-2)",
            color: "var(--text-muted)",
          }}
        >
          <Play size={11} strokeWidth={2} fill="currentColor" />
        </button>
        <span
          className="text-[11px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text-subtle)" }}
        >
          {elapsedTimecode} / {formatDuration(duration)}
        </span>
        <div
          className="flex-1"
          style={{
            height: 3,
            background: "var(--surface-2)",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${progressPct}%`,
              height: "100%",
              background: "var(--accent)",
              borderRadius: 2,
              transition: "width 200ms",
            }}
          />
        </div>
      </div>

      <div className="relative">
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 4,
            top: 6,
            bottom: 6,
            width: 1,
            background: "var(--border-strong)",
          }}
        />
        <ul className="space-y-3.5 relative">
          {markers.map((m, i) => {
            const active = i === activeIdx;
            const dotColor =
              m.kind === "assistant"
                ? "var(--text-muted)"
                : m.kind === "tool"
                  ? "var(--verified)"
                  : "var(--accent)";
            return (
              <li
                key={m.id}
                onClick={() => onSeek(i)}
                className="relative cursor-pointer group"
                style={{ paddingLeft: 22 }}
                title={m.witnessHash ? `${m.label} · ${m.witnessHash}` : m.label}
              >
                {active ? (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: -10,
                      right: -10,
                      top: -3,
                      bottom: -3,
                      background: "rgba(239,233,220,0.05)",
                      borderTop: "1px solid rgba(239,233,220,0.25)",
                      borderBottom: "1px solid rgba(239,233,220,0.25)",
                    }}
                  />
                ) : null}
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 1,
                    top: 6,
                    width: 9,
                    height: 9,
                    borderRadius: 999,
                    background: dotColor,
                    boxShadow: "0 0 0 2px var(--bg)",
                  }}
                />
                <div
                  className="text-[11.5px] flex items-baseline gap-1.5 relative"
                  style={{ color: active ? "var(--text)" : "var(--text-muted)" }}
                >
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}>
                    {m.timestamp}
                  </span>
                  <span style={{ fontFamily: m.kind === "tool" ? "var(--font-mono)" : undefined }}>
                    {m.label}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ChaptersDropdown was the previous chapters affordance. The 2026-05-08
// design comp inlines the chapters as 3 ghost-sm buttons in the player
// footer, so the dropdown is no longer mounted. Kept as a no-op
// reference for the LucideChevronDown + Check imports until those
// chips move elsewhere.
void LucideChevronDown;
void Check;

function Mono({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.94em",
        color: "var(--syn-fn)",
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 4,
        padding: "0 5px",
      }}
    >
      {children}
    </span>
  );
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function formatRelativeAge(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  const day = 86_400_000;
  const days = Math.floor(delta / day);
  if (days < 1) return "today";
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

