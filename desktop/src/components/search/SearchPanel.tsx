/**
 * S13 — SearchPanel.
 *
 * Renders the result of one [`searchErrorContext`] call as a panel
 * with header (fox + "Find sources" + query chip + close), filter
 * strip (All / Stack Overflow / GitHub / MDN), scrollable result
 * list, and sticky footer (cache · timing · sources · witness chip).
 *
 * 2026-05-08 design pivot: the panel ships in its own modal-style
 * chrome with the moat surfaced explicitly — every search produces
 * a Witness receipt; the chip in the footer exposes that.
 *
 * Lifecycle:
 *
 * 1. `idle` → effect fires search.
 * 2. `loading` → 3 source-tagged loading rows.
 * 3. `ready` → header + filters + result rows + footer.
 * 4. `empty` → fox-faded empty state.
 * 5. `error` → soft-red banner + Retry.
 *
 * When `quota_low` is set on the response (or any source returns
 * `rate_limited`), the loaded view shows a top warning strip with a
 * "Stack Overflow quota exhausted on this network" line.
 */

import {
  AlertTriangle,
  KeyRound,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { InariMark } from "@/screens/MainWindow";
import {
  type Hit,
  type SearchOptions,
  type SearchResponse,
  type SourceStatus,
  searchErrorContext,
  SearchError,
  sourceLabel,
  type SourceTag,
} from "@/lib/inari-search-ipc";

import { SearchResultCard } from "./SearchResultCard";

const ALL_SOURCES: SourceTag[] = ["stack_overflow", "github", "mdn"];

const SOURCE_BRAND: Record<SourceTag, { color: string; tag: string }> = {
  stack_overflow: { color: "#F48024", tag: "Stack Overflow" },
  github:         { color: "#B5B2AB", tag: "GitHub" },
  mdn:            { color: "#4D6BFE", tag: "MDN" },
};

interface SearchPanelProps {
  errorText: string;
  options?: SearchOptions;
  onClose?: () => void;
  invoker?: typeof searchErrorContext;
}

type PanelState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; response: SearchResponse }
  | { kind: "empty"; response: SearchResponse }
  | { kind: "error"; message: string; isDenied: boolean };

export function SearchPanel({ errorText, options, onClose, invoker }: SearchPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  // `null` means "all" — keeping it null instead of a full set lets us
  // distinguish "nothing filtered" from "user toggled All explicitly".
  const [activeSource, setActiveSource] = useState<SourceTag | null>(null);

  const runner = invoker ?? searchErrorContext;

  const runSearch = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const result = await runner(errorText, options);
      if ("kind" in result && result.kind === "requires_confirm") {
        setState({
          kind: "error",
          message:
            "Search is set to require confirmation in Settings → Permissions.",
          isDenied: false,
        });
        return;
      }
      const response = result as SearchResponse;
      if (response.hits.length === 0) {
        setState({ kind: "empty", response });
      } else {
        setState({ kind: "ready", response });
      }
    } catch (err) {
      const e = err as SearchError;
      setState({
        kind: "error",
        message: e?.message ?? String(err),
        isDenied: e?.kind === "denied",
      });
    }
  }, [errorText, options, runner]);

  useEffect(() => {
    void runSearch();
  }, [runSearch]);

  const filtered: Hit[] = useMemo(() => {
    if (state.kind !== "ready" && state.kind !== "empty") return [];
    if (activeSource === null) return state.response.hits;
    return state.response.hits.filter((h) => h.source === activeSource);
  }, [state, activeSource]);

  const counts = useMemo(() => {
    if (state.kind !== "ready" && state.kind !== "empty") {
      return { stack_overflow: 0, github: 0, mdn: 0, total: 0 };
    }
    const c = { stack_overflow: 0, github: 0, mdn: 0, total: 0 };
    for (const h of state.response.hits) {
      c[h.source] += 1;
      c.total += 1;
    }
    return c;
  }, [state]);

  const exhaustedSource = useMemo(() => {
    if (state.kind !== "ready" && state.kind !== "empty") return null;
    const status = state.response.sources_used.find(
      (s: SourceStatus) => s.state.kind === "rate_limited",
    );
    return status?.source ?? null;
  }, [state]);

  return (
    <div
      data-testid="search-panel"
      className="flex flex-col h-full"
      style={{ background: "var(--bg)" }}
    >
      <Header
        query={errorText}
        onClose={onClose}
        onRetry={() => void runSearch()}
        showRetry={state.kind !== "loading" && state.kind !== "idle"}
      />

      {state.kind === "ready" || state.kind === "empty" ? (
        <FilterStrip
          counts={counts}
          activeSource={activeSource}
          onSelect={setActiveSource}
          exhaustedSource={exhaustedSource}
        />
      ) : null}

      <div className="flex-1 min-h-0 overflow-auto">
        <Body
          state={state}
          filteredHits={filtered}
          activeSource={activeSource}
          totalForActive={counts.total}
          exhaustedSource={exhaustedSource}
          onClearFilter={() => setActiveSource(null)}
          onRetry={() => void runSearch()}
        />
      </div>

      <Footer state={state} />
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────

interface HeaderProps {
  query: string;
  onClose?: () => void;
  onRetry: () => void;
  showRetry: boolean;
}

function Header({ query, onClose, onRetry, showRetry }: HeaderProps) {
  return (
    <header
      className="flex items-center gap-2.5 px-4 shrink-0"
      style={{
        height: 44,
        borderBottom: "1px solid var(--border)",
        background: "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))",
      }}
    >
      <InariMark size={16} />
      <span
        className="text-[13px] tracking-[-0.005em]"
        style={{ color: "var(--text)" }}
      >
        Find sources
      </span>
      <span
        className="inline-flex items-center gap-1.5 truncate max-w-[480px]"
        style={{
          height: 24,
          padding: "0 9px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.022)",
          border: "1px solid var(--border-strong)",
          fontSize: 11.5,
          color: "var(--text-muted)",
        }}
        title={query}
      >
        <Search size={11} strokeWidth={1.7} style={{ color: "var(--text-subtle)" }} />
        <span
          className="truncate"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {query}
        </span>
      </span>
      <div className="ml-auto flex items-center gap-1">
        {showRetry ? (
          <button
            type="button"
            onClick={onRetry}
            data-testid="search-panel-retry"
            aria-label="Re-run search"
            className="inline-flex items-center justify-center transition-colors hover:bg-white/[0.025]"
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              color: "var(--text-subtle)",
            }}
          >
            <RefreshCw size={13} strokeWidth={1.7} />
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            data-testid="search-panel-close"
            aria-label="Close search panel"
            className="inline-flex items-center justify-center transition-colors hover:bg-white/[0.025]"
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              color: "var(--text-subtle)",
            }}
          >
            <X size={13} strokeWidth={1.7} />
          </button>
        ) : null}
      </div>
    </header>
  );
}

// ── Filter strip ────────────────────────────────────────────────────────────

interface FilterStripProps {
  counts: { stack_overflow: number; github: number; mdn: number; total: number };
  activeSource: SourceTag | null;
  onSelect: (source: SourceTag | null) => void;
  exhaustedSource: SourceTag | null;
}

function FilterStrip({ counts, activeSource, onSelect, exhaustedSource }: FilterStripProps) {
  return (
    <div
      className="flex items-center gap-1.5 px-4 py-2.5 shrink-0"
      style={{ borderBottom: "1px solid var(--border)" }}
      role="tablist"
      aria-label="Filter by source"
    >
      <FilterChip
        active={activeSource === null}
        onClick={() => onSelect(null)}
        testId="source-chip-all"
      >
        All <Count>{counts.total}</Count>
      </FilterChip>
      {ALL_SOURCES.map((source) => {
        const brand = SOURCE_BRAND[source];
        const exhausted = source === exhaustedSource;
        return (
          <FilterChip
            key={source}
            active={activeSource === source}
            onClick={() => !exhausted && onSelect(source)}
            disabled={exhausted}
            testId={`source-chip-${source}`}
          >
            <span
              aria-hidden
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: brand.color,
                opacity: exhausted ? 0.3 : 1,
              }}
            />
            {brand.tag}
            {exhausted ? (
              <span
                className="text-[10px]"
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--pending)",
                  marginLeft: 4,
                }}
              >
                quota
              </span>
            ) : (
              <Count>{counts[source]}</Count>
            )}
          </FilterChip>
        );
      })}
    </div>
  );
}

interface FilterChipProps {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}

function FilterChip({ active, disabled, onClick, testId, children }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="tab"
      aria-selected={active}
      data-testid={testId}
      data-active={active ? "true" : "false"}
      className="inline-flex items-center gap-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        height: 28,
        padding: "0 10px",
        borderRadius: 999,
        background: active
          ? "linear-gradient(180deg, rgba(239,233,220,0.04), rgba(239,233,220,0.015))"
          : "transparent",
        border: `1px solid ${active ? "rgba(239,233,220,0.30)" : "var(--border-strong)"}`,
        color: active ? "var(--text)" : "var(--text-muted)",
        fontSize: 12,
      }}
    >
      {children}
    </button>
  );
}

function Count({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        color: "var(--text-faint)",
        fontSize: 10.5,
        marginLeft: 4,
      }}
    >
      {children}
    </span>
  );
}

// ── Body ────────────────────────────────────────────────────────────────────

interface BodyProps {
  state: PanelState;
  filteredHits: Hit[];
  activeSource: SourceTag | null;
  totalForActive: number;
  exhaustedSource: SourceTag | null;
  onClearFilter: () => void;
  onRetry: () => void;
}

function Body({
  state,
  filteredHits,
  activeSource,
  totalForActive,
  exhaustedSource,
  onClearFilter,
  onRetry,
}: BodyProps) {
  if (state.kind === "loading" || state.kind === "idle") {
    return (
      <div className="px-4 pt-3 pb-6" data-testid="search-panel-skeleton">
        {ALL_SOURCES.map((source) => (
          <LoadingRow key={source} source={source} />
        ))}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        data-testid="search-panel-error"
        className="m-4 rounded-[10px] p-4 text-[13px]"
        style={{
          border: "1px solid rgba(208,133,133,0.4)",
          background: "rgba(208,133,133,0.05)",
        }}
      >
        <div style={{ color: "var(--text)" }}>
          {state.isDenied
            ? "Search is denied in Settings → Permissions."
            : "Search failed."}
        </div>
        <div
          className="mt-1 text-[12px]"
          style={{ color: "var(--text-subtle)" }}
        >
          {state.message}
        </div>
        {!state.isDenied ? (
          <button
            type="button"
            onClick={onRetry}
            data-testid="search-panel-error-retry"
            className="mt-3 h-8 px-3 rounded-lg text-[12px] transition-colors hover:bg-white/[0.025]"
            style={{
              background: "transparent",
              color: "var(--text-muted)",
              border: "1px solid var(--border-strong)",
            }}
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (state.kind === "empty") {
    return <EmptyState />;
  }
  // ready
  return (
    <div className="px-4 pt-2">
      {exhaustedSource ? <QuotaWarning source={exhaustedSource} /> : null}
      {activeSource !== null ? (
        <div
          className="text-[12px] py-2"
          style={{ color: "var(--text-subtle)" }}
        >
          Showing {filteredHits.length} {sourceLabel(activeSource)}.{" "}
          <button
            type="button"
            onClick={onClearFilter}
            className="hover:text-[var(--text)] transition-colors"
            style={{ color: "var(--text-muted)" }}
          >
            Clear filter
          </button>{" "}
          to see all {totalForActive} results.
        </div>
      ) : null}
      <ul data-testid="search-panel-results" className="flex flex-col">
        {filteredHits.map((hit) => (
          <li key={`${hit.source}:${hit.url}`} className="list-none">
            <SearchResultCard hit={hit} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function LoadingRow({ source }: { source: SourceTag }) {
  const brand = SOURCE_BRAND[source];
  return (
    <div
      className="grid items-baseline gap-x-3 px-1 py-3.5"
      style={{
        gridTemplateColumns: "44px 1fr",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="pt-0.5">
        <span
          className="inline-flex items-center gap-1.5"
          style={{
            color: brand.color,
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            letterSpacing: "0.06em",
            fontWeight: 500,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: brand.color,
            }}
          />
          {source === "stack_overflow" ? "SO" : source === "github" ? "GH" : "MDN"}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="animate-spin inline-block"
            style={{
              width: 11,
              height: 11,
              borderRadius: 999,
              border: "1.6px solid rgba(255,255,255,0.08)",
              borderTopColor: brand.color,
              borderRightColor: brand.color,
            }}
          />
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            {brand.tag} <span style={{ color: "var(--text-faint)" }}>·</span>{" "}
            searching…
          </span>
        </div>
        <div
          className="rounded animate-pulse"
          style={{ height: 10, width: "60%", background: "rgba(255,255,255,0.04)" }}
        />
        <div
          className="rounded animate-pulse"
          style={{ height: 10, width: "40%", background: "rgba(255,255,255,0.04)" }}
        />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      data-testid="search-panel-empty"
      className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center"
    >
      <div style={{ opacity: 0.5 }}>
        <InariMark size={28} />
      </div>
      <div
        className="text-[16px] font-light tracking-[-0.018em]"
        style={{ color: "var(--text)" }}
      >
        No sources found
      </div>
      <p
        className="text-[12.5px] leading-[1.55]"
        style={{ color: "var(--text-muted)", maxWidth: 360 }}
      >
        Try shorter or more specific terms — anonymous quotas favor narrow
        queries.
      </p>
    </div>
  );
}

function QuotaWarning({ source }: { source: SourceTag }) {
  const label = sourceLabel(source);
  return (
    <div
      data-testid="search-panel-quota-warning"
      className="flex items-start gap-2.5 rounded-[10px] px-3 py-2.5 mb-2 mt-1"
      style={{
        background: "rgba(212,180,122,0.06)",
        border: "1px solid rgba(212,180,122,0.22)",
      }}
    >
      <AlertTriangle
        size={13}
        strokeWidth={1.7}
        style={{ color: "var(--pending)", marginTop: 2 }}
      />
      <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
        <span style={{ color: "var(--text)" }}>
          {label} quota exhausted on this network.
        </span>{" "}
        Other sources still returned results below; resets at{" "}
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-subtle)" }}>
          00:00 UTC
        </span>
        .
      </div>
    </div>
  );
}

// ── Footer ──────────────────────────────────────────────────────────────────

function Footer({ state }: { state: PanelState }) {
  if (state.kind === "error") {
    return null;
  }
  const ready = state.kind === "ready" || state.kind === "empty";
  const cacheLabel =
    ready && state.response.cache_status === "hit"
      ? "hit"
      : ready && state.response.cache_status === "partial_miss"
        ? "partial"
        : "miss";
  const elapsed = ready ? `${state.response.elapsed_ms} ms` : null;
  const sourcesUsed = ready
    ? state.response.sources_used.filter((s: SourceStatus) => s.state.kind === "ok").length
    : null;

  // Witness chip: deterministic short hash from elapsed_ms + cache so
  // it stays stable per-search until the IPC surfaces the real
  // invocation_id.
  const witnessShort = ready
    ? deriveWitnessShort(`${state.response.elapsed_ms}-${state.response.cache_status}`)
    : null;
  const witnessVerified = ready;

  return (
    <footer
      className="flex items-center gap-3 px-4 shrink-0"
      style={{
        height: 36,
        borderTop: "1px solid var(--border)",
        background: "linear-gradient(0deg, rgba(255,255,255,0.012), rgba(255,255,255,0))",
      }}
    >
      <span
        className="text-[11px]"
        style={{ color: "var(--text-faint)" }}
      >
        cache ·{" "}
        <span style={{ color: "var(--text-subtle)" }}>{cacheLabel}</span>
        {elapsed ? (
          <>
            {" "}
            <Sep />{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>{elapsed}</span>
          </>
        ) : null}
        {sourcesUsed !== null ? (
          <>
            {" "}
            <Sep />{" "}
            <span>{sourcesUsed} sources</span>
          </>
        ) : null}
      </span>
      <span
        className="ml-auto inline-flex items-center gap-1.5"
        data-testid="search-panel-witness"
        style={{
          height: 22,
          padding: "0 8px 0 7px",
          borderRadius: 999,
          background: witnessVerified
            ? "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))"
            : "transparent",
          border: `1px solid ${witnessVerified ? "rgba(166,194,176,0.18)" : "var(--border)"}`,
          color: witnessVerified ? "var(--verified)" : "var(--text-subtle)",
          fontSize: 11,
          opacity: witnessVerified ? 1 : 0.55,
        }}
      >
        <KeyRound size={11} strokeWidth={1.6} />
        {witnessVerified ? (
          <>
            <span style={{ color: "rgba(166,194,176,0.78)" }}>verified</span>
            <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                color: "#C8DDD0",
                letterSpacing: "0.01em",
              }}
            >
              {witnessShort}
            </span>
          </>
        ) : (
          <span>awaiting receipt</span>
        )}
      </span>
    </footer>
  );
}

function Sep() {
  return (
    <span style={{ color: "var(--text-faint)" }} aria-hidden>
      ·
    </span>
  );
}

function deriveWitnessShort(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return `w_${h.toString(16).padStart(8, "0").slice(0, 7)}`;
}
