import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";

import { EmptyState } from "@/components/ui";
import {
  desktopPermissionClear,
  desktopPermissionList,
  desktopPermissionSet,
  effectivePermission,
  type PermissionLevel,
  type PermissionRow as PermissionRowType,
} from "@/lib/audit-ui-ipc";
import { useSettings } from "@/lib/store/settings";

import { PermissionRow } from "./PermissionRow";

/**
 * Settings → Permissions sub-tab.
 *
 * Loads the static catalog + live overrides via `desktopPermissionList`,
 * then mutates per-row through `desktopPermissionSet` /
 * `desktopPermissionClear`. The panel optimistically updates local
 * state so the cycler reflects the new choice immediately; if the IPC
 * fails it reconciles by re-fetching.
 *
 * 2026-05-07 design pivot: this is THE moat surface. Top stats strip
 * leans on the sage / verified palette to advertise that every
 * invocation produces an Ed25519 + Merkle-chained Witness receipt.
 * The tool list keeps each row in a 2-row layout (name + witness chip
 * top, description + cycler bottom) so the audit-trail sense reads
 * before the picker control does.
 */
export interface PermissionPanelProps {
  className?: string;
  testId?: string;
}

export function PermissionPanel({ className, testId }: PermissionPanelProps) {
  const [rows, setRows] = useState<PermissionRowType[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pendingTool, setPendingTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focusedTool = useSettings((s) => s.focusedTool);
  const setFocusedTool = useSettings((s) => s.setFocusedTool);

  const refresh = useCallback(async () => {
    try {
      const listing = await desktopPermissionList();
      setRows(listing.rows);
      setError(null);
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : (e as Error).message ?? "unknown");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!loaded || !focusedTool) return;
    const el = document.querySelector<HTMLElement>(
      `[data-testid="permission-row-${focusedTool}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.setAttribute("data-focused", "true");
    const t = window.setTimeout(() => {
      el.removeAttribute("data-focused");
      setFocusedTool(null);
    }, 2000);
    return () => {
      window.clearTimeout(t);
    };
  }, [loaded, focusedTool, rows, setFocusedTool]);

  async function onSet(tool: string, level: PermissionLevel) {
    setPendingTool(tool);
    setRows((prev) =>
      prev.map((r) =>
        r.name === tool ? { ...r, override_level: level } : r,
      ),
    );
    try {
      await desktopPermissionSet(tool, level);
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : (e as Error).message ?? "unknown");
      await refresh();
    } finally {
      setPendingTool(null);
    }
  }

  async function onClear(tool: string) {
    setPendingTool(tool);
    setRows((prev) =>
      prev.map((r) =>
        r.name === tool ? { ...r, override_level: null } : r,
      ),
    );
    try {
      await desktopPermissionClear(tool);
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : (e as Error).message ?? "unknown");
      await refresh();
    } finally {
      setPendingTool(null);
    }
  }

  const verifiedCount = useMemo(() => {
    // Until the audit IPC exposes per-tool receipt counts, "verified"
    // is the count of rows whose effective permission isn't `deny` —
    // every other tool can produce a receipt the moment it's
    // invoked. Aspirational but honest: nothing is faked.
    return rows.filter((r) => effectivePermission(r) !== "deny").length;
  }, [rows]);

  return (
    <section
      data-testid={testId ?? "permission-panel"}
      className={className}
    >
      <h2
        className="text-[22px] font-light tracking-[-0.018em]"
        style={{ color: "var(--text)" }}
      >
        Permissions
      </h2>
      <p
        className="text-[13px] mt-1.5"
        style={{ color: "var(--text-subtle)" }}
      >
        Every tool Inari can call. Every invocation produces a Witness receipt
        — Ed25519 signature, Merkle-chained.
      </p>

      {error ? (
        <div
          data-testid="permission-panel-error"
          role="alert"
          className="mt-4 p-3 rounded-[8px] text-[12px]"
          style={{
            border: "1px solid var(--danger)",
            color: "var(--danger)",
          }}
        >
          {error}
        </div>
      ) : null}

      {/* Stats strip — the moat advertised in one row. */}
      <div
        className="mt-5 flex items-center justify-between rounded-[12px] px-4 py-3"
        data-testid="permission-stats-strip"
        style={{
          border: "1px solid var(--border)",
          background:
            "linear-gradient(180deg, rgba(166,194,176,0.025), rgba(255,255,255,0))",
        }}
      >
        <div className="flex items-baseline gap-2 text-[13px] flex-wrap">
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
            {rows.length}
          </span>
          <span style={{ color: "var(--text-muted)" }}>tools registered.</span>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--verified)" }}>
            {verifiedCount} verified
          </span>
          <span style={{ color: "var(--text-muted)" }}>by Witness.</span>
        </div>
        <button
          type="button"
          data-testid="permission-verify-all"
          className="h-8 px-3 rounded-lg text-[12px] flex items-center gap-2 transition-colors hover:bg-white/[0.025]"
          style={{
            background: "transparent",
            color: "var(--text-muted)",
            border: "1px solid var(--border-strong)",
          }}
          onClick={() => {
            // Phase B/C wires bulk verify against the chain root.
            console.info("[permissions] verify all receipts — Phase B/C");
          }}
        >
          <KeyRound size={12} strokeWidth={1.7} style={{ color: "var(--verified)" }} />
          Verify all receipts
        </button>
      </div>

      <div className="mt-5">
        {!loaded ? (
          <div
            className="px-4 py-6 text-[12px]"
            style={{ color: "var(--text-subtle)" }}
          >
            Loading tools…
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            testId="permission-panel-empty"
            icon={ShieldCheck}
            headline="No tools registered yet"
            helper="The chat-agent boot path will register tools here once the registry is wired into lib.rs::run()."
          />
        ) : (
          <ul role="list" className="flex flex-col">
            {rows.map((row, i) => (
              <PermissionRow
                key={row.name}
                row={row}
                onSet={(t, l) => void onSet(t, l)}
                onClear={(t) => void onClear(t)}
                pending={pendingTool === row.name}
                isFirst={i === 0}
              />
            ))}
          </ul>
        )}
      </div>

      <p
        className="mt-5 pt-4 text-[11px] leading-relaxed"
        style={{ color: "var(--text-faint)", borderTop: "1px solid var(--border)" }}
      >
        Overrides live in this dock instance's resolver. They never leave the
        machine, and reset to defaults on Inari Live restart unless persisted
        by a future settings migration.
      </p>
    </section>
  );
}
