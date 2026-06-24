import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Copy, X } from "lucide-react";

import { AuditFilters } from "@/components/audit/AuditFilters";
import { AuditTable } from "@/components/audit/AuditTable";
import { AuditDetailPanel } from "@/components/audit/AuditDetailPanel";
import { WitnessVerifierModal } from "@/components/audit/WitnessVerifierModal";
import {
  desktopAuditList,
  desktopPermissionList,
  type AuditEntry,
  type AuditFilter,
  type PermissionRow,
} from "@/lib/audit-ui-ipc";

const PAGE_LIMIT = 50;

const INITIAL_FILTER: AuditFilter = {
  limit: PAGE_LIMIT,
  order: "newest_first",
};

interface MainAuditProps {
  /** Optional close handler — wires the titlebar X when MainAudit
   *  is mounted as a chat-first overlay (cmd+/ surface) rather than
   *  a permanent route. Omit to hide the X. */
  onClose?: () => void;
}

/**
 * Audit log archive. Per the 2026-05-07 chat-first design comp
 * (Surface 2): titlebar with `Audit log · {N} invocations · chain
 * root {hash}` framing, filter chips, split list + detail panel.
 *
 * The titlebar's chain-root badge is the surface's publishable
 * commitment — copy-out lets a workspace owner post the hash
 * externally to commit publicly to the session's history. Until the
 * audit IPC starts surfacing a real chain root we render a
 * deterministic placeholder.
 */
export function MainAudit({ onClose }: MainAuditProps = {}) {
  const [filter, setFilter] = useState<AuditFilter>(INITIAL_FILTER);
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [verifyId, setVerifyId] = useState<string | null>(null);
  const [tools, setTools] = useState<PermissionRow[]>([]);

  const refresh = useCallback(async (f: AuditFilter) => {
    setLoading(true);
    try {
      const page = await desktopAuditList(f);
      setRows(page.rows);
      setTotal(page.total);
      setNextCursor(page.next_cursor);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    desktopPermissionList().then((listing) => setTools(listing.rows));
  }, []);

  useEffect(() => {
    void refresh(filter);
  }, [filter, refresh]);

  function onChangeFilter(next: AuditFilter) {
    setFilter(next);
  }

  function flipSort() {
    setFilter((f) => ({
      ...f,
      order: f.order === "oldest_first" ? "newest_first" : "oldest_first",
      cursor_started_at_ms: undefined,
    }));
  }

  async function loadMore() {
    if (nextCursor === null) return;
    setLoading(true);
    try {
      const page = await desktopAuditList({
        ...filter,
        cursor_started_at_ms: nextCursor,
      });
      setRows((prev) => [...prev, ...page.rows]);
      setNextCursor(page.next_cursor);
    } finally {
      setLoading(false);
    }
  }

  // Chain root placeholder — derived deterministically from the most
  // recent receipt so the badge has stable content per session.
  // Replaced by a real chain root once the audit IPC surfaces it.
  const chainRoot = useMemo(() => {
    if (rows.length === 0) return null;
    const latest = rows[0]!.id;
    const stripped = latest.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return `${stripped.slice(0, 7)}…${stripped.slice(-4) || stripped.slice(0, 4)}`;
  }, [rows]);

  return (
    <section
      data-testid="main-audit"
      className="h-full w-full flex flex-col"
      style={{ background: "var(--bg)" }}
    >
      <header
        className="flex items-center justify-between px-5 shrink-0"
        style={{
          height: 44,
          borderBottom: "1px solid var(--border)",
          background: "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))",
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--verified)" }}>
            <path d="M14 3v4a1 1 0 0 0 1 1h4" />
            <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
            <line x1="9" y1="13" x2="15" y2="13" />
            <line x1="9" y1="17" x2="13" y2="17" />
          </svg>
          <span className="text-[13px] tracking-[-0.005em]" style={{ color: "var(--text)" }}>
            Audit log
          </span>
          <span style={{ color: "var(--text-faint)" }} className="mx-1">·</span>
          <span className="text-[12.5px]" style={{ color: "var(--text-muted)" }}>
            {total === 0
              ? "no invocations yet"
              : `${total.toLocaleString()} invocation${total === 1 ? "" : "s"}`}
          </span>
          {chainRoot ? (
            <>
              <span style={{ color: "var(--text-faint)" }} className="mx-1">·</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(chainRoot);
                }}
                title="Copy chain root"
                className="inline-flex items-center gap-1.5 transition-colors hover:bg-white/[0.025]"
                style={{
                  height: 24,
                  padding: "0 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "rgba(255,255,255,0.018)",
                  color: "var(--text-muted)",
                  fontSize: 11.5,
                }}
              >
                <span style={{ color: "var(--text-faint)" }}>chain root</span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--verified)",
                    letterSpacing: "0.01em",
                  }}
                >
                  {chainRoot}
                </span>
                <Copy size={10} strokeWidth={1.6} style={{ color: "var(--text-faint)" }} />
              </button>
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            data-testid="main-audit-sort"
            aria-label={
              filter.order === "newest_first" ? "Sort oldest first" : "Sort newest first"
            }
            onClick={flipSort}
            className="transition-colors hover:bg-white/[0.025]"
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "rgba(255,255,255,0.018)",
              color: "var(--text-muted)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {filter.order === "newest_first" ? (
              <ArrowDown size={13} strokeWidth={1.7} />
            ) : (
              <ArrowUp size={13} strokeWidth={1.7} />
            )}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close audit log"
              data-testid="main-audit-close"
              className="transition-colors"
              style={{ color: "var(--text-subtle)" }}
            >
              <X size={14} strokeWidth={1.7} />
            </button>
          ) : null}
        </div>
      </header>

      <AuditFilters
        filter={filter}
        onChange={onChangeFilter}
        toolOptions={tools}
      />

      <div className="flex-1 min-h-0 flex">
        <AuditTable
          rows={rows}
          selectedId={selectedId}
          onSelectRow={setSelectedId}
          onOpenWitness={(id) => setVerifyId(id)}
          loading={loading}
        />
        <AuditDetailPanel
          selectedId={selectedId}
          onClose={() => setSelectedId(null)}
          onVerify={(id) => setVerifyId(id)}
        />
      </div>

      {nextCursor !== null && rows.length > 0 ? (
        <div
          className="px-6 py-3 flex items-center justify-center shrink-0"
          style={{ borderTop: "1px solid var(--border)", background: "var(--bg)" }}
        >
          <button
            type="button"
            data-testid="main-audit-load-more"
            disabled={loading}
            onClick={() => void loadMore()}
            className="h-8 px-3.5 rounded-lg text-[12.5px] transition-colors hover:bg-white/[0.025] disabled:opacity-50"
            style={{
              background: "transparent",
              color: "var(--text-muted)",
              border: "1px solid var(--border-strong)",
            }}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}

      <WitnessVerifierModal
        invocationId={verifyId}
        onOpenChange={(open) => {
          if (!open) setVerifyId(null);
        }}
      />
    </section>
  );
}
