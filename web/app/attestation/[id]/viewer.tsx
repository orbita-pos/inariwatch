"use client";

/**
 * AttestationViewer — client-side chain renderer.
 *
 * Fetches /api/attestation/:id and renders the full EAP chain +
 * verification report. Handles every realistic state with a clear
 * informational panel:
 *
 *   - loading           Loading skeleton
 *   - 503 not configured The workspace hasn't deployed EAP yet —
 *                        surface the hint, don't pretend it's a failure.
 *   - 404 not found      Receipt ID doesn't exist in the chain DB.
 *   - 502 upstream       EAP server is unreachable.
 *   - 400 bad id         Receipt ID format is wrong.
 *   - 200 success        Render verification + chain.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Copy,
  Download,
  Loader2,
  Info,
  AlertTriangle,
  Clock,
  Terminal,
  Database,
  Globe,
  Sparkles,
} from "lucide-react";

interface ReceiptMeta {
  receipt_id: string;
  recording_id: string;
  started_at: string;
  ended_at: string | null;
  command: string[];
  runtime: string;
  event_count: number;
  eap_version: string;
  attested_at: string;
}

interface LlmCall {
  provider: string;
  model: string;
}

interface AttestationSurfaces {
  http_endpoints?: string[];
  db_tables?: string[];
  file_paths?: string[];
  llm_calls?: LlmCall[];
  tool_uses?: { name: string }[];
}

interface ChainLink {
  receipt_id: string;
  relation: "called_by" | "continuation_of" | "depends_on";
}

interface ExecutionReceipt {
  meta: ReceiptMeta;
  event_hashes: string[];
  categories: Record<string, number>;
  surfaces: AttestationSurfaces;
  parents?: ChainLink[];
  signature?: {
    attestor: string;
    signature: string;
  };
}

interface VerifyReport {
  verified: boolean;
  chain_depth: number;
  errors?: string[];
  [k: string]: unknown;
}

interface ChainResponse {
  chain: ExecutionReceipt[];
  verification: VerifyReport;
}

type State =
  | { kind: "loading" }
  | { kind: "success"; data: ChainResponse }
  | { kind: "not-configured"; hint?: string }
  | { kind: "not-found" }
  | { kind: "bad-id" }
  | { kind: "upstream-error" }
  | { kind: "network-error"; message: string };

export function AttestationViewer({ receiptId }: { receiptId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/attestation/${encodeURIComponent(receiptId)}`);
        if (cancelled) return;
        if (res.status === 400) {
          setState({ kind: "bad-id" });
          return;
        }
        if (res.status === 404) {
          setState({ kind: "not-found" });
          return;
        }
        if (res.status === 503) {
          const body = await res.json().catch(() => ({}));
          setState({
            kind: "not-configured",
            hint: typeof body?.hint === "string" ? body.hint : undefined,
          });
          return;
        }
        if (res.status === 502 || res.status === 504) {
          setState({ kind: "upstream-error" });
          return;
        }
        if (!res.ok) {
          setState({ kind: "network-error", message: `HTTP ${res.status}` });
          return;
        }
        const data = (await res.json()) as ChainResponse;
        setState({ kind: "success", data });
      } catch (e) {
        if (cancelled) return;
        setState({
          kind: "network-error",
          message: e instanceof Error ? e.message : "Network error",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [receiptId]);

  if (state.kind === "loading") return <LoadingPanel />;
  if (state.kind === "not-configured") return <NotConfiguredPanel hint={state.hint} />;
  if (state.kind === "not-found") return <NotFoundPanel receiptId={receiptId} />;
  if (state.kind === "bad-id") return <BadIdPanel />;
  if (state.kind === "upstream-error") return <UpstreamPanel />;
  if (state.kind === "network-error") return <NetworkPanel message={state.message} />;
  return <SuccessPanel data={state.data} />;
}

// ── States ────────────────────────────────────────────────────────────────

function LoadingPanel() {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 flex items-center gap-2 text-xs text-fg-base/60">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      Loading attestation…
    </div>
  );
}

function NotConfiguredPanel({ hint }: { hint?: string }) {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-start gap-2 text-xs">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
      <div>
        <p className="font-medium text-amber-700 dark:text-amber-300">
          EAP server not yet deployed for this InariWatch instance
        </p>
        <p className="mt-1 text-fg-base/70">
          {hint ?? "The workspace has not deployed the EAP attestation server."}
        </p>
      </div>
    </div>
  );
}

function NotFoundPanel({ receiptId }: { receiptId: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 flex items-start gap-2 text-xs">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-fg-base/50" aria-hidden />
      <div>
        <p className="font-medium text-fg-strong">Receipt not found</p>
        <p className="mt-1 text-fg-base/70">
          No attestation exists for{" "}
          <code className="font-mono">{receiptId.slice(0, 16)}…</code>. Check
          the ID or confirm it came from this workspace.
        </p>
      </div>
    </div>
  );
}

function BadIdPanel() {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-fg-base/70">
      Receipt IDs are 8–64 hexadecimal characters. This ID looks malformed.
    </div>
  );
}

function UpstreamPanel() {
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 flex items-start gap-2 text-xs">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden />
      <div>
        <p className="font-medium text-red-700 dark:text-red-300">
          EAP server temporarily unavailable
        </p>
        <p className="mt-1 text-fg-base/70">
          The attestation server did not respond in time. Refresh in a moment.
        </p>
      </div>
    </div>
  );
}

function NetworkPanel({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-fg-base/70">
      Couldn&apos;t load attestation: {message}
    </div>
  );
}

// ── Success ───────────────────────────────────────────────────────────────

function SuccessPanel({ data }: { data: ChainResponse }) {
  const top = data.chain[0];
  if (!top) {
    return (
      <div className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-fg-base/70">
        Empty chain.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <VerificationBadge report={data.verification} />
      <TopReceiptCard receipt={top} />
      {data.chain.length > 1 && <ChainList chain={data.chain.slice(1)} />}
      <ReceiptActions data={data} />
    </div>
  );
}

function VerificationBadge({ report }: { report: VerifyReport }) {
  const passed = report.verified;
  const tone = passed
    ? {
        bg: "bg-emerald-500/15",
        border: "border-emerald-500/30",
        text: "text-emerald-700 dark:text-emerald-300",
        Icon: ShieldCheck,
        label: "Chain verified",
      }
    : {
        bg: "bg-red-500/15",
        border: "border-red-500/30",
        text: "text-red-700 dark:text-red-300",
        Icon: ShieldAlert,
        label: "Chain verification FAILED",
      };
  return (
    <div className={`rounded-xl border ${tone.border} ${tone.bg} px-4 py-3`}>
      <div className={`flex items-center gap-2 ${tone.text}`}>
        <tone.Icon className="h-4 w-4" aria-hidden />
        <span className="font-semibold">{tone.label}</span>
        <span className="text-[10px] uppercase tracking-wider opacity-70">
          chain depth: {report.chain_depth}
        </span>
      </div>
      {Array.isArray(report.errors) && report.errors.length > 0 && (
        <ul className="mt-2 text-[11px] text-red-700 dark:text-red-300 space-y-0.5 pl-6 list-disc">
          {report.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TopReceiptCard({ receipt }: { receipt: ExecutionReceipt }) {
  const durationMs =
    receipt.meta.ended_at
      ? new Date(receipt.meta.ended_at).getTime() -
        new Date(receipt.meta.started_at).getTime()
      : null;
  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="border-b border-line px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
          Top-level execution
        </h2>
      </div>
      <div className="px-4 py-3 space-y-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
          <Field Icon={Terminal} label="Command">
            <code className="font-mono text-fg-strong">
              {receipt.meta.command.join(" ")}
            </code>
          </Field>
          <Field Icon={Clock} label="Started">
            <span className="tabular-nums">{fmtTs(receipt.meta.started_at)}</span>
          </Field>
          {durationMs !== null && (
            <Field Icon={Clock} label="Duration">
              <span className="tabular-nums">{fmtDuration(durationMs)}</span>
            </Field>
          )}
          <Field Icon={Info} label="Runtime">
            <span>{receipt.meta.runtime}</span>
          </Field>
          <Field Icon={Info} label="Events">
            <span className="tabular-nums">
              {receipt.meta.event_count.toLocaleString()} attested I/O events
            </span>
          </Field>
          <Field Icon={Info} label="EAP version">
            <span className="font-mono">{receipt.meta.eap_version}</span>
          </Field>
        </div>

        <SurfaceSection surfaces={receipt.surfaces} />

        {receipt.signature && (
          <div className="rounded-lg border border-line/60 bg-surface-inner px-3 py-2 text-[10px] space-y-0.5">
            <div className="text-fg-base/50 uppercase tracking-wider">
              Ed25519 signature
            </div>
            <div className="font-mono break-all text-fg-base/70">
              attestor: {receipt.signature.attestor}
            </div>
            <div className="font-mono break-all text-fg-base/70">
              sig: {receipt.signature.signature.slice(0, 32)}…
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  Icon,
  label,
  children,
}: {
  Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-center gap-1 text-fg-base/50 uppercase tracking-wider text-[9px]">
        <Icon className="h-3 w-3" aria-hidden />
        <span>{label}</span>
      </div>
      <div className="min-w-0 break-words">{children}</div>
    </>
  );
}

function SurfaceSection({ surfaces }: { surfaces: AttestationSurfaces }) {
  const http = surfaces.http_endpoints ?? [];
  const db = surfaces.db_tables ?? [];
  const llms = surfaces.llm_calls ?? [];
  const files = surfaces.file_paths ?? [];
  if (!http.length && !db.length && !llms.length && !files.length) return null;
  return (
    <div className="rounded-lg border border-line/60 bg-surface-inner px-3 py-2 space-y-1.5">
      <div className="text-[9px] uppercase tracking-wider text-fg-base/50">
        Attested surfaces
      </div>
      {http.length > 0 && (
        <SurfaceRow Icon={Globe} label="HTTP endpoints" items={http} />
      )}
      {db.length > 0 && (
        <SurfaceRow Icon={Database} label="DB tables" items={db} />
      )}
      {llms.length > 0 && (
        <SurfaceRow
          Icon={Sparkles}
          label="LLM calls"
          items={llms.map((c) => `${c.provider}/${c.model}`)}
        />
      )}
      {files.length > 0 && (
        <SurfaceRow Icon={Terminal} label="File paths" items={files} />
      )}
    </div>
  );
}

function SurfaceRow({
  Icon,
  label,
  items,
}: {
  Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  items: string[];
}) {
  return (
    <div className="flex items-start gap-2 text-[10px]">
      <Icon className="mt-0.5 h-3 w-3 shrink-0 text-fg-base/50" aria-hidden />
      <span className="w-20 shrink-0 text-fg-base/50 uppercase tracking-wider text-[9px]">
        {label}
      </span>
      <div className="flex flex-wrap gap-1 min-w-0">
        {items.slice(0, 12).map((it) => (
          <code
            key={it}
            className="rounded bg-fg-base/10 px-1.5 py-0.5 font-mono text-fg-base/80"
          >
            {it}
          </code>
        ))}
        {items.length > 12 && (
          <span className="text-fg-base/40">+{items.length - 12} more</span>
        )}
      </div>
    </div>
  );
}

function ChainList({ chain }: { chain: ExecutionReceipt[] }) {
  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="border-b border-line px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-strong">
          Parent chain ({chain.length})
        </h2>
      </div>
      <ul className="divide-y divide-line/60">
        {chain.map((r, i) => (
          <li key={r.meta.receipt_id} className="px-4 py-2 text-[11px]">
            <div className="flex items-center gap-2">
              <span className="text-fg-base/40 w-6 tabular-nums">#{i + 1}</span>
              <code className="font-mono text-fg-strong truncate">
                {r.meta.receipt_id.slice(0, 16)}…
              </code>
              <span className="text-fg-base/50 text-[10px] ml-auto">
                {r.meta.command.join(" ").slice(0, 40)}
              </span>
            </div>
            <div className="mt-0.5 pl-8 text-[10px] text-fg-base/50 tabular-nums">
              {fmtTs(r.meta.started_at)} · {r.meta.event_count} events
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReceiptActions({ data }: { data: ChainResponse }) {
  const [copied, setCopied] = useState(false);
  const topId = data.chain[0]?.meta.receipt_id ?? "";

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(topId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  }, [topId]);

  const onDownload = useCallback(() => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eap-receipt-${topId.slice(0, 16)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [data, topId]);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-inner px-2.5 py-1 text-[11px] font-medium text-fg-base/80 hover:border-inari-accent/40 hover:text-fg-strong"
      >
        <Copy className="h-3 w-3" aria-hidden />
        {copied ? "Copied" : "Copy receipt ID"}
      </button>
      <button
        type="button"
        onClick={onDownload}
        className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-inner px-2.5 py-1 text-[11px] font-medium text-fg-base/80 hover:border-inari-accent/40 hover:text-fg-strong"
      >
        <Download className="h-3 w-3" aria-hidden />
        Download JSON
      </button>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const rem = Math.round(s - mins * 60);
  return `${mins}m ${rem}s`;
}
