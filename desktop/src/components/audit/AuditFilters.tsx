import { Calendar, ChevronDown, Search, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";

import type {
  AuditFilter,
  AuditOrder,
  PermissionRow,
} from "@/lib/audit-ui-ipc";

/**
 * 2026-05-07 design pivot — chip-based filter bar.
 *
 * Search input on the left, hairline filter chips for tool / outcome
 * / date / session, sort flip icon, result counter pinned right. At
 * rest, every chip reads structural (mono ink + muted label). When
 * filtered, the chip itself takes on the outcome's own color at ~8%
 * alpha and the chevron flips to a small ✕ to signal "click to
 * clear" — keeps the bar from looking alarmed when nothing's wrong.
 */
export interface AuditFiltersProps {
  filter: AuditFilter;
  onChange: (next: AuditFilter) => void;
  toolOptions: PermissionRow[];
  className?: string;
  testId?: string;
}

type DateBucket = "today" | "7d" | "30d" | "any";

function bucketFromMs(since?: number): DateBucket {
  if (!since) return "any";
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  if (Math.abs(start.getTime() - since) < day) return "today";
  if (now - since <= 7 * day + 1000) return "7d";
  if (now - since <= 30 * day + 1000) return "30d";
  return "any";
}

function msFromBucket(b: DateBucket): number | undefined {
  if (b === "any") return undefined;
  const day = 24 * 60 * 60 * 1000;
  if (b === "today") {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    return start.getTime();
  }
  if (b === "7d") return Date.now() - 7 * day;
  if (b === "30d") return Date.now() - 30 * day;
  return undefined;
}

export function AuditFilters({
  filter,
  onChange,
  toolOptions,
  className,
  testId,
}: AuditFiltersProps) {
  function patch(next: Partial<AuditFilter>) {
    onChange({ ...filter, ...next, cursor_started_at_ms: undefined });
  }

  const dateBucket = bucketFromMs(filter.since_ms);
  const outcomeValue: "all" | "ok" | "fail" =
    filter.success === undefined ? "all" : filter.success ? "ok" : "fail";

  return (
    <div
      data-testid={testId ?? "audit-filters"}
      className={["px-6 py-3 flex items-center gap-3 flex-wrap shrink-0", className]
        .filter(Boolean)
        .join(" ")}
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <SearchInput
        value={filter.text ?? ""}
        onChange={(v) => patch({ text: v || undefined })}
      />

      <FilterChip
        label="tool"
        value={filter.tool_name ?? "any"}
        active={filter.tool_name !== undefined}
        onClear={() => patch({ tool_name: undefined })}
        options={[
          { value: "", label: "Any tool" },
          ...toolOptions.map((t) => ({ value: t.name, label: t.name })),
        ]}
        onSelect={(v) => patch({ tool_name: v || undefined })}
      />

      <FilterChip
        label="outcome"
        value={
          outcomeValue === "all" ? "all" : outcomeValue === "ok" ? "success" : "failed"
        }
        active={outcomeValue !== "all"}
        tone={outcomeValue === "fail" ? "red" : outcomeValue === "ok" ? "sage" : "neutral"}
        onClear={() => patch({ success: undefined })}
        options={[
          { value: "all", label: "All outcomes" },
          { value: "ok", label: "Success only" },
          { value: "fail", label: "Failed only" },
        ]}
        onSelect={(v) =>
          patch({
            success: v === "all" ? undefined : v === "ok",
          })
        }
        leadingDot={
          outcomeValue === "ok"
            ? "var(--verified)"
            : outcomeValue === "fail"
              ? "var(--denied)"
              : "var(--text-faint)"
        }
      />

      <FilterChip
        label="date"
        value={
          dateBucket === "today"
            ? "today"
            : dateBucket === "7d"
              ? "7 days"
              : dateBucket === "30d"
                ? "30 days"
                : "any"
        }
        active={dateBucket !== "any"}
        onClear={() => patch({ since_ms: undefined })}
        options={[
          { value: "any", label: "Any time" },
          { value: "today", label: "Today" },
          { value: "7d", label: "Past 7 days" },
          { value: "30d", label: "Past 30 days" },
        ]}
        onSelect={(v) =>
          patch({
            since_ms: msFromBucket(v as DateBucket),
          })
        }
        leadingIcon={Calendar}
      />

      <FilterChip
        label="session"
        value={filter.session_id ? filter.session_id.slice(0, 8) : "any"}
        active={!!filter.session_id}
        onClear={() => patch({ session_id: undefined })}
        // Session is a free-text field — we keep a tiny inline input
        // inside the popover instead of a static option list.
        valueIsMono
        renderPopover={({ close }) => (
          <SessionInput
            initial={filter.session_id ?? ""}
            onSubmit={(v) => {
              patch({ session_id: v.trim() ? v.trim() : undefined });
              close();
            }}
          />
        )}
      />

      <SortFlipButton
        order={filter.order ?? "newest_first"}
        onFlip={() =>
          patch({
            order:
              filter.order === "oldest_first" ? "newest_first" : "oldest_first",
          })
        }
      />

      <ResultCounter filter={filter} />
    </div>
  );
}

// ── Search input ────────────────────────────────────────────────────────────

interface SearchInputProps {
  value: string;
  onChange: (next: string) => void;
}

function SearchInput({ value, onChange }: SearchInputProps) {
  return (
    <div className="relative flex-1 min-w-[200px] max-w-[320px]">
      <Search
        className="absolute left-2.5 top-1/2 -translate-y-1/2"
        size={12}
        strokeWidth={1.7}
        style={{ color: "var(--text-subtle)" }}
        aria-hidden
      />
      <input
        type="search"
        data-testid="audit-filter-text"
        placeholder="Search invocations…"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        className="w-full h-8 pl-7 pr-2.5 text-[12.5px] outline-none transition-colors"
        style={{
          background: "rgba(255,255,255,0.022)",
          border: "1px solid var(--border-strong)",
          borderRadius: 8,
          color: "var(--text)",
          letterSpacing: "-0.005em",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--border-3)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "var(--border-strong)";
        }}
      />
    </div>
  );
}

// ── Filter chip ─────────────────────────────────────────────────────────────

interface ChipOption {
  value: string;
  label: string;
}

interface FilterChipProps {
  label: string;
  value: string;
  active: boolean;
  /** Tone tints the chip when active. */
  tone?: "neutral" | "sage" | "red" | "gold";
  onClear: () => void;
  options?: ChipOption[];
  onSelect?: (value: string) => void;
  leadingDot?: string;
  leadingIcon?: LucideIcon;
  valueIsMono?: boolean;
  renderPopover?: (api: { close: () => void }) => ReactNode;
}

function FilterChip({
  label,
  value,
  active,
  tone = "neutral",
  onClear,
  options,
  onSelect,
  leadingDot,
  leadingIcon: LeadingIcon,
  valueIsMono = false,
  renderPopover,
}: FilterChipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const tones = {
    neutral: { bg: "rgba(255,255,255,0.018)", border: "var(--border-strong)" },
    sage: {
      bg: "rgba(166,194,176,0.08)",
      border: "rgba(166,194,176,0.22)",
    },
    red: {
      bg: "rgba(208,133,133,0.08)",
      border: "rgba(208,133,133,0.22)",
    },
    gold: {
      bg: "rgba(212,180,122,0.08)",
      border: "rgba(212,180,122,0.22)",
    },
  };
  const palette = active ? tones[tone] : tones.neutral;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid={`audit-filter-${label}`}
        data-active={active ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 transition-colors"
        style={{
          height: 30,
          padding: "0 10px",
          borderRadius: 8,
          background: palette.bg,
          border: `1px solid ${palette.border}`,
          fontSize: 12,
          color: "var(--text)",
          letterSpacing: "-0.005em",
        }}
      >
        {LeadingIcon ? (
          <LeadingIcon size={11} strokeWidth={1.6} style={{ color: "var(--text-subtle)" }} />
        ) : null}
        <span style={{ color: "var(--text-subtle)" }}>{label}</span>
        {leadingDot ? (
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              borderRadius: 999,
              background: leadingDot,
            }}
          />
        ) : null}
        <span style={{ fontFamily: valueIsMono ? "var(--font-mono)" : undefined }}>
          {value}
        </span>
        {active ? (
          <span
            role="button"
            aria-label={`Clear ${label} filter`}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
              setOpen(false);
            }}
            className="inline-flex items-center justify-center"
            style={{ color: "var(--text-subtle)", cursor: "pointer" }}
          >
            <X size={11} strokeWidth={2} />
          </span>
        ) : (
          <ChevronDown size={11} strokeWidth={1.8} style={{ color: "var(--text-subtle)" }} />
        )}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute z-30 mt-1.5"
          style={{
            top: "100%",
            left: 0,
            minWidth: 180,
            background: "#131318",
            border: "1px solid var(--border-strong)",
            borderRadius: 10,
            padding: 6,
            boxShadow:
              "0 16px 40px -8px rgba(0,0,0,0.7), 0 4px 12px -2px rgba(0,0,0,0.4)",
          }}
        >
          {renderPopover
            ? renderPopover({ close: () => setOpen(false) })
            : options?.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelect?.(opt.value);
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 transition-colors hover:bg-white/[0.025]"
                  style={{
                    height: 30,
                    borderRadius: 6,
                    color: "var(--text-muted)",
                    fontSize: 12.5,
                    textAlign: "left",
                  }}
                >
                  <span>{opt.label}</span>
                </button>
              ))}
        </div>
      ) : null}
    </div>
  );
}

interface SessionInputProps {
  initial: string;
  onSubmit: (value: string) => void;
}

function SessionInput({ initial, onSubmit }: SessionInputProps) {
  const [value, setValue] = useState(initial);
  return (
    <div className="p-1.5 w-[200px]">
      <input
        type="text"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="session id…"
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit(value);
        }}
        className="w-full h-8 px-2 outline-none"
        style={{
          background: "rgba(255,255,255,0.025)",
          border: "1px solid var(--border-strong)",
          borderRadius: 6,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--text)",
        }}
      />
    </div>
  );
}

// ── Sort flip + counter ─────────────────────────────────────────────────────

interface SortFlipButtonProps {
  order: AuditOrder;
  onFlip: () => void;
}

function SortFlipButton({ order, onFlip }: SortFlipButtonProps) {
  const newest = order === "newest_first";
  return (
    <button
      type="button"
      data-testid="audit-filter-sort"
      aria-label={newest ? "Sort oldest first" : "Sort newest first"}
      onClick={onFlip}
      className="inline-flex items-center justify-center transition-colors hover:bg-white/[0.025]"
      style={{
        width: 30,
        height: 30,
        borderRadius: 8,
        border: "1px solid var(--border-strong)",
        background: "rgba(255,255,255,0.018)",
        color: "var(--text-muted)",
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {newest ? (
          <>
            <path d="M12 5v14" />
            <path d="M6 13l6 6 6-6" />
          </>
        ) : (
          <>
            <path d="M12 19V5" />
            <path d="M6 11l6-6 6 6" />
          </>
        )}
      </svg>
    </button>
  );
}

interface ResultCounterProps {
  filter: AuditFilter;
}

function ResultCounter({ filter }: ResultCounterProps) {
  const failedActive = filter.success === false;
  return (
    <div
      className="ml-auto text-[11.5px]"
      style={{ fontFamily: "var(--font-mono)", color: "var(--text-subtle)" }}
      data-testid="audit-result-counter"
    >
      {failedActive ? (
        <>
          <span style={{ color: "var(--text-muted)" }}>match</span>{" "}
          <span style={{ color: "var(--denied)" }}>outcome: failed</span>
        </>
      ) : (
        <span>filter active</span>
      )}
    </div>
  );
}

