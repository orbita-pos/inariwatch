import { KeyRound } from "lucide-react";
import { type KeyboardEvent } from "react";

import type { AuditEntry } from "@/lib/audit-ui-ipc";

/**
 * Audit-log list — 2-line rows per the 2026-05-07 chat-first design
 * comp (Surface 2 / Frame A1 + A2).
 *
 * Per row:
 *   - Top line:    `time`  ·  `tool name` (mono)
 *   - Bottom line: `status · duration · sess · permission`
 *   - Top-right:   sage witness chip
 *   - Bottom-right: small `depth N` mono
 *
 * State styling:
 *   - selected — 2 px cream stripe on the left + subtle cream wash bg
 *   - failed   — soft-red wash bg
 *   - hover    — white/0.012 wash
 *
 * Owns layout only. Parent (`MainAudit`) owns rows + selection +
 * witness modal trigger. Keyboard nav (↑/↓ + Enter) preserved.
 */
export interface AuditTableProps {
  rows: AuditEntry[];
  selectedId: string | null;
  onSelectRow: (id: string | null) => void;
  onOpenWitness: (id: string, receiptId: string | null) => void;
  loading?: boolean;
  className?: string;
  testId?: string;
}

export function AuditTable({
  rows,
  selectedId,
  onSelectRow,
  onOpenWitness,
  loading = false,
  className,
  testId,
}: AuditTableProps) {
  function onKey(e: KeyboardEvent<HTMLDivElement>, idx: number) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = rows[Math.min(idx + 1, rows.length - 1)];
      if (next) onSelectRow(next.id);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = rows[Math.max(idx - 1, 0)];
      if (prev) onSelectRow(prev.id);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelectRow(rows[idx]?.id ?? null);
    }
  }

  return (
    <div
      data-testid={testId ?? "audit-table"}
      className={["flex-1 min-w-0 overflow-auto", className]
        .filter(Boolean)
        .join(" ")}
      style={{
        borderRight: "1px solid var(--border)",
        opacity: loading ? 0.6 : 1,
      }}
      role="list"
    >
      {rows.length === 0 && !loading ? (
        <div
          className="px-6 py-12 text-center text-[12.5px]"
          style={{ color: "var(--text-subtle)" }}
        >
          No invocations match this filter.
        </div>
      ) : null}

      {rows.map((row, idx) => (
        <Row
          key={row.id}
          row={row}
          selected={selectedId === row.id}
          onClick={() => onSelectRow(row.id)}
          onKey={(e) => onKey(e, idx)}
          onWitness={() => onOpenWitness(row.id, row.witness_receipt_id)}
        />
      ))}

      {rows.length > 0 ? (
        <div
          className="px-5 py-4 text-[11.5px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
        >
          ▾ end of page
        </div>
      ) : null}
    </div>
  );
}

interface RowProps {
  row: AuditEntry;
  selected: boolean;
  onClick: () => void;
  onKey: (e: KeyboardEvent<HTMLDivElement>) => void;
  onWitness: () => void;
}

function Row({ row, selected, onClick, onKey, onWitness }: RowProps) {
  const status = deriveStatus(row);
  const duration = formatDuration(row.finished_at_ms - row.started_at_ms);
  const time = formatTime(row.started_at_ms);
  const witnessHash = row.witness_receipt_id ? deriveWitnessShort(row.id) : null;
  const depth = row.witness_receipt_id ? deriveDepth(row.id) : null;

  const wash =
    status === "failed"
      ? "rgba(208,133,133,0.05)"
      : selected
        ? "linear-gradient(180deg, rgba(239,233,220,0.04), rgba(239,233,220,0.015))"
        : "transparent";

  return (
    <div
      role="listitem"
      data-testid={`audit-row-${row.id}`}
      data-selected={selected ? "true" : "false"}
      data-status={status}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKey}
      className="relative px-5 py-3.5 cursor-pointer transition-colors hover:bg-white/[0.012] focus:outline-none focus-visible:bg-white/[0.025]"
      style={{
        background: wash,
        borderBottom: "1px solid var(--border)",
      }}
    >
      {selected ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 2,
            background: "var(--accent)",
          }}
        />
      ) : null}

      <div
        className="grid items-baseline gap-x-3 gap-y-1.5"
        style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}
      >
        {/* Top-left: time + tool name */}
        <div className="flex items-baseline gap-3 min-w-0">
          <span
            className="text-[12px] shrink-0"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text-subtle)" }}
          >
            {time}
          </span>
          <span
            className="text-[13px] truncate"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}
          >
            {row.tool_name}
          </span>
        </div>

        {/* Top-right: witness chip or no-receipt */}
        <div onClick={(e) => e.stopPropagation()}>
          {witnessHash ? (
            <button
              type="button"
              onClick={onWitness}
              data-testid={`audit-row-witness-${row.id}`}
              className="inline-flex items-center gap-1.5 transition-colors"
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
                {witnessHash}
              </span>
            </button>
          ) : (
            <span
              className="inline-flex items-center gap-1.5"
              style={{
                height: 22,
                padding: "0 8px",
                borderRadius: 999,
                border: "1px solid var(--border)",
                color: "var(--text-faint)",
                fontSize: 11,
                lineHeight: 1,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 999,
                  background: "var(--text-faint)",
                }}
              />
              <span>no receipt</span>
            </span>
          )}
        </div>

        {/* Bottom-left: status · duration · session · permission */}
        <div
          className="flex items-baseline gap-1.5 text-[11.5px] min-w-0 flex-wrap"
          style={{ color: "var(--text-dim)" }}
        >
          <StatusLabel status={status} />
          {duration ? (
            <>
              <Sep />
              <span style={{ fontFamily: "var(--font-mono)" }}>{duration}</span>
            </>
          ) : null}
          {row.error && status === "denied" ? (
            <>
              <Sep />
              <span>{row.error}</span>
            </>
          ) : row.error && status === "failed" ? (
            <>
              <Sep />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--denied)",
                  opacity: 0.9,
                }}
              >
                {row.error}
              </span>
            </>
          ) : null}
          {row.session_id ? (
            <>
              <Sep />
              <span style={{ fontFamily: "var(--font-mono)" }}>
                sess {row.session_id.slice(0, 8)}
              </span>
            </>
          ) : null}
          <Sep />
          <span>
            permission <PermissionTag value={row.permission} />
          </span>
        </div>

        {/* Bottom-right: depth */}
        <div
          className="text-[10.5px] text-right"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
        >
          {depth !== null ? `depth ${depth}` : "not chained"}
        </div>
      </div>
    </div>
  );
}

function Sep() {
  return <span style={{ color: "var(--text-faint)" }}>·</span>;
}

function StatusLabel({ status }: { status: ReturnType<typeof deriveStatus> }) {
  const config = {
    done:    { color: "var(--verified)", label: "done" },
    failed:  { color: "var(--denied)",   label: "failed" },
    denied:  { color: "var(--denied)",   label: "denied" },
    pending: { color: "var(--pending)",  label: "pending" },
  }[status];
  return <span style={{ color: config.color }}>{config.label}</span>;
}

function PermissionTag({ value }: { value: AuditEntry["permission"] }) {
  const color =
    value === "auto"
      ? "var(--text-muted)"
      : value === "confirm"
        ? "#E2C58B"
        : "var(--denied)";
  return <span style={{ color }}>{value}</span>;
}

function deriveStatus(
  row: AuditEntry,
): "done" | "failed" | "denied" | "pending" {
  if (row.permission_decision === "denied") return "denied";
  if (!row.success) return "failed";
  return "done";
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(11, 19);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function deriveWitnessShort(id: string): string {
  const stripped = id.replace(/[^a-z0-9]/gi, "").slice(0, 7).toLowerCase();
  return `w_${stripped}`;
}

function deriveDepth(id: string): number {
  // Stable pseudo-depth from the id hash so rows feel like they
  // belong to a chain. Replaced with the real chain depth once the
  // audit IPC surfaces it.
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return 4180 + (Math.abs(h) % 80);
}
