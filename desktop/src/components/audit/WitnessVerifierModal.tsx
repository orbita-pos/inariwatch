import { Check, ChevronDown, ChevronRight, Copy, KeyRound, RefreshCw, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Dialog } from "@/components/ui";
import {
  desktopAuditGet,
  desktopAuditVerify,
  type AuditEntry,
  type SignatureStatus,
  type VerifyResult,
} from "@/lib/audit-ui-ipc";

/**
 * Witness verifier modal — the "moment of trust" surface.
 *
 * Per the 2026-05-07 chat-first design pivot: 640×720 modal opened
 * when the user clicks a `verified · w_…` chip on a tool call. Four
 * stacked sections:
 *
 *   1. Tool head row — name + status pill + duration + timestamp
 *      + session id.
 *   2. Verification checklist — 4 rows, glyph + title + inline
 *      helper + status tag. Sage/red/muted depending on state.
 *   3. Receipt header — kv card with mono hex truncations, divided
 *      into Identity / Signature / Chain sections.
 *   4. Args + Output — collapsible JSON cards with byte counts.
 *
 * Footer carries the primary "Re-verify locally" action (cream) and
 * a ghost "Copy raw bytes" alternate. The "last verified" timestamp
 * sits in the trailing whitespace.
 *
 * The signature row honestly renders a hollow / muted state for the
 * `not_yet_signed` lifecycle moment — receipts pre-S6 are
 * metadata-only and we don't fake a green check on them.
 */
export interface WitnessVerifierModalProps {
  /** When set, modal opens for this audit row's id. `null` hides it. */
  invocationId: string | null;
  onOpenChange: (open: boolean) => void;
  testId?: string;
}

export function WitnessVerifierModal({
  invocationId,
  onOpenChange,
  testId,
}: WitnessVerifierModalProps) {
  const open = invocationId !== null;
  const [entry, setEntry] = useState<AuditEntry | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!invocationId) {
      setEntry(null);
      setVerify(null);
      setError(null);
      return;
    }
    setError(null);
    Promise.all([desktopAuditGet(invocationId), desktopAuditVerify(invocationId)])
      .then(([row, v]) => {
        if (!cancelled) {
          setEntry(row);
          setVerify(v);
          setLastVerifiedAt(new Date());
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(typeof e === "string" ? e : (e as Error).message ?? "unknown");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [invocationId]);

  async function reverify() {
    if (!invocationId) return;
    try {
      const v = await desktopAuditVerify(invocationId);
      setVerify(v);
      setLastVerifiedAt(new Date());
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : (e as Error).message ?? "unknown");
    }
  }

  const witnessShort = entry ? deriveWitnessShort(entry.id) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="!w-[min(94vw,640px)]"
      // Box-model lives in inline style so it always wins over Dialog's
      // base `max-h-[85vh] overflow-auto p-5`. `cn()` is a plain
      // concatenator (not tailwind-merge), so a Tailwind override like
      // `!overflow-hidden` only resolves correctly if the generated CSS
      // happens to put `overflow-hidden` later in the file — fragile.
      // Inline style always wins the cascade and unblocks the inner
      // scrolling div below.
      style={{
        maxHeight: "min(90vh, 720px)",
        padding: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        data-testid={testId ?? "witness-verifier-modal"}
        // `display: contents` makes this wrapper transparent for layout —
        // the inner header / scroll-middle / footer become direct flex
        // items of RadixDialog.Content (which is `flex flex-col` via the
        // inline style above). Without this, the previous `flex flex-col
        // h-full` chain broke: `h-full` only resolves to a real value
        // when the parent has a defined `height`, but RadixDialog.Content
        // has only `max-height`, so the wrapper collapsed to content size
        // and the inner `flex-1 min-h-0 overflow-auto` had no constrained
        // parent to scroll within. The wrapper is preserved (not
        // unwrapped) so the `data-testid="witness-verifier-modal"` hook
        // tests rely on stays where it is.
        style={{ display: "contents" }}
      >
        <header
          className="flex items-center justify-between px-5 shrink-0"
          style={{
            height: 44,
            borderBottom: "1px solid var(--border)",
            background: "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))",
          }}
        >
          <div className="flex items-center gap-2.5">
            <KeyRound size={13} strokeWidth={1.6} style={{ color: "var(--verified)" }} />
            <span
              className="text-[13px] tracking-[-0.005em]"
              style={{ color: "var(--text)" }}
            >
              Witness receipt
            </span>
          </div>
          <div className="flex items-center gap-3">
            {witnessShort ? (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: "#C8DDD0",
                  letterSpacing: "0.01em",
                }}
              >
                {witnessShort}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
              data-testid="witness-verifier-close"
              className="transition-colors"
              style={{ color: "var(--text-subtle)" }}
            >
              <X size={14} strokeWidth={1.6} />
            </button>
          </div>
        </header>

        <div className="flex-1 min-h-0 overflow-auto px-6 pt-5 pb-6">
          {error ? (
            <div
              data-testid="witness-verifier-error"
              role="alert"
              className="p-3 rounded-[8px] text-[12px] mb-4"
              style={{ border: "1px solid var(--danger)", color: "var(--danger)" }}
            >
              Verification failed to load: {error}
            </div>
          ) : null}

          {entry && verify ? (
            // Section order is intentional: lead with the value the user
            // came to see (Output), then context (Args), then the trust
            // signal (Verification stays open — short, reassuring), then
            // the noisy hash dump (Receipt header collapses by default).
            // Pre-fix this was reversed and buried Output behind ceremony.
            <div className="space-y-4">
              <ToolHeadRow entry={entry} />
              <OutputCard entry={entry} />
              <ArgsCard entry={entry} />
              <VerificationChecklist entry={entry} verify={verify} />
              <CollapsibleSection
                title="Receipt header"
                summary={receiptSummary(verify)}
              >
                <ReceiptHeader verify={verify} witnessShort={witnessShort ?? ""} />
              </CollapsibleSection>
            </div>
          ) : !error ? (
            <div className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
              Loading audit row…
            </div>
          ) : null}
        </div>

        <footer
          className="flex items-center gap-2 px-6 py-3 shrink-0"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <button
            type="button"
            onClick={reverify}
            data-testid="witness-verifier-reverify"
            disabled={!entry}
            className="h-9 px-4 rounded-lg text-[12.5px] font-medium flex items-center gap-2 transition-transform active:scale-[0.98] disabled:opacity-50"
            style={{
              background: "var(--accent)",
              color: "var(--accent-ink)",
              border: "1px solid rgba(0,0,0,0.18)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 0 rgba(0,0,0,0.45)",
            }}
          >
            <RefreshCw size={12} strokeWidth={1.8} />
            Re-verify locally
          </button>
          <CopyRawButton entry={entry} verify={verify} />
          {lastVerifiedAt ? (
            <span
              className="ml-auto text-[11px]"
              style={{ color: "var(--text-faint)" }}
            >
              Last verified{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {lastVerifiedAt.toISOString().slice(11, 23)}Z
              </span>
            </span>
          ) : null}
        </footer>
      </div>
    </Dialog>
  );
}

interface CopyRawButtonProps {
  entry: AuditEntry | null;
  verify: VerifyResult | null;
}

function CopyRawButton({ entry, verify }: CopyRawButtonProps) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!entry || !verify) return;
    const blob = JSON.stringify(
      {
        invocation_id: entry.id,
        tool_name: entry.tool_name,
        session_id: entry.session_id,
        args_sha256: verify.recorded_args_sha256,
        output_sha256: verify.recorded_result_sha256,
        signature: verify.signature,
        permission: entry.permission,
        permission_decision: entry.permission_decision,
        started_at_ms: entry.started_at_ms,
        finished_at_ms: entry.finished_at_ms,
        success: entry.success,
      },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(blob);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* silent */
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      data-testid="witness-verifier-copy-raw"
      disabled={!entry}
      className="h-9 px-4 rounded-lg text-[12.5px] flex items-center gap-2 transition-colors hover:bg-white/[0.025] disabled:opacity-50"
      style={{
        background: "transparent",
        color: "var(--text-muted)",
        border: "1px solid var(--border-strong)",
      }}
    >
      <Copy size={12} strokeWidth={1.6} />
      {copied ? "Copied" : "Copy raw bytes"}
    </button>
  );
}

interface ToolHeadRowProps {
  entry: AuditEntry;
}

function ToolHeadRow({ entry }: ToolHeadRowProps) {
  const status = entry.success ? "done" : "failed";
  const duration = Math.max(0, entry.finished_at_ms - entry.started_at_ms);
  const ts = new Date(entry.started_at_ms);
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="text-[14px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}
        >
          {entry.tool_name}
        </span>
        <StatusPill status={status} />
        <span
          className="ml-auto text-[11.5px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}
        >
          {formatDuration(duration)}
        </span>
      </div>
      <div
        className="text-[12px] mt-2 flex items-center gap-2 flex-wrap"
        style={{ color: "var(--text-dim)" }}
      >
        <span>
          Invoked at{" "}
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-subtle)" }}>
            {ts.toISOString().slice(11, 19)}
          </span>{" "}
          UTC
        </span>
        {entry.session_id ? (
          <>
            <span style={{ color: "var(--text-faint)" }}>·</span>
            <span>
              session{" "}
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-subtle)" }}>
                {entry.session_id.slice(0, 8)}
              </span>
            </span>
          </>
        ) : null}
        <span style={{ color: "var(--text-faint)" }}>·</span>
        <span>
          permission{" "}
          <span style={{ color: "var(--text-muted)" }}>{entry.permission}</span>
        </span>
      </div>
    </div>
  );
}

interface VerificationChecklistProps {
  entry: AuditEntry;
  verify: VerifyResult;
}

function VerificationChecklist({ entry, verify }: VerificationChecklistProps) {
  const noReceipt = verify.signature === "no_receipt";
  const argsState: CheckState = noReceipt
    ? "neutral"
    : verify.args_hash_match
      ? "ok"
      : "fail";
  const resultState: CheckState =
    entry.result_json === null
      ? "neutral"
      : verify.result_hash_match
        ? "ok"
        : "fail";
  const sigState = signatureCheckState(verify.signature);
  // Chain check is aspirational — placeholder until receipts carry
  // chain depth / parent / root fields. Render as neutral so it
  // honestly says "not yet wired".
  const chainState: CheckState = "neutral";

  return (
    <div>
      <Eyebrow>Verification checklist</Eyebrow>
      <div
        className="rounded-[10px] overflow-hidden mt-2.5"
        style={{
          border: "1px solid var(--border)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.012), rgba(255,255,255,0))",
        }}
      >
        <CheckRow
          testId="witness-verifier-args"
          state={argsState}
          title="Args hash matches recorded receipt"
          helper={
            <>
              sha256{" "}
              <Mono>{shortHash(verify.computed_args_sha256)}</Mono>{" "}
              recomputed locally{" "}
              <span style={{ color: "var(--text-faint)" }}>·</span>{" "}
              {argsState === "ok"
                ? "matches"
                : argsState === "fail"
                  ? "MISMATCH"
                  : "no recorded value to compare"}
            </>
          }
        />
        <CheckRow
          testId="witness-verifier-result"
          state={resultState}
          title="Output hash matches recorded receipt"
          helper={
            entry.result_json === null
              ? "Invocation failed before producing a result — nothing to verify"
              : (
                <>
                  sha256{" "}
                  <Mono>{shortHash(verify.computed_result_sha256 ?? "")}</Mono>{" "}
                  recomputed locally{" "}
                  <span style={{ color: "var(--text-faint)" }}>·</span>{" "}
                  {resultState === "ok" ? "matches" : "MISMATCH"}
                </>
              )
          }
        />
        <CheckRow
          testId="witness-verifier-signature"
          state={sigState}
          title="Ed25519 signature valid"
          helper={signatureHelper(verify.signature)}
        />
        <CheckRow
          testId="witness-verifier-chain"
          state={chainState}
          title="Chain link consistent"
          helper="Receipts will carry chain depth + parent hash once Witness chain v2 ships. Verifying on-disk integrity only for now."
          isLast
        />
      </div>
    </div>
  );
}

type CheckState = "ok" | "fail" | "neutral";

interface CheckRowProps {
  testId: string;
  state: CheckState;
  title: string;
  helper: ReactNode;
  isLast?: boolean;
}

function CheckRow({ testId, state, title, helper, isLast = false }: CheckRowProps) {
  const tagText = state === "ok" ? "passed" : state === "fail" ? "failed" : "n/a";
  const tagColor =
    state === "ok"
      ? "var(--verified-2)"
      : state === "fail"
        ? "var(--danger)"
        : "var(--text-faint)";
  const rowBg =
    state === "fail" ? "rgba(208,133,133,0.05)" : undefined;

  return (
    <div
      data-testid={testId}
      data-state={state}
      role="listitem"
      className="grid items-start gap-3 px-4 py-3"
      style={{
        gridTemplateColumns: "16px 1fr auto",
        borderTop: "none",
        borderBottom: isLast ? "none" : "1px solid var(--border)",
        background: rowBg,
      }}
    >
      <CheckIcon state={state} />
      <div>
        <div className="text-[13px]" style={{ color: "var(--text)" }}>
          {title}
        </div>
        <div className="text-[11.5px] mt-1" style={{ color: "var(--text-dim)" }}>
          {helper}
        </div>
      </div>
      <span className="text-[11px]" style={{ color: tagColor }}>
        {tagText}
      </span>
    </div>
  );
}

function CheckIcon({ state }: { state: CheckState }) {
  if (state === "ok") {
    return (
      <Check
        size={14}
        strokeWidth={2.4}
        style={{ color: "var(--verified)", marginTop: 2 }}
        aria-label="passed"
      />
    );
  }
  if (state === "fail") {
    return (
      <X
        size={14}
        strokeWidth={2.4}
        style={{ color: "var(--danger)", marginTop: 2 }}
        aria-label="failed"
      />
    );
  }
  return (
    <span
      aria-label="not yet applicable"
      style={{
        width: 12,
        height: 12,
        borderRadius: 999,
        border: "1.5px solid var(--text-faint)",
        marginTop: 4,
      }}
    />
  );
}

interface ReceiptHeaderProps {
  verify: VerifyResult;
  witnessShort: string;
}

function ReceiptHeader({ verify, witnessShort }: ReceiptHeaderProps) {
  return (
    <div>
      <Eyebrow>Receipt header</Eyebrow>
      <div
        className="rounded-[10px] overflow-hidden mt-2.5"
        style={{
          border: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <KvRow k="receipt id" v={witnessShort || "—"} sage />
        <KvRow k="args sha256" v={chunkHash(verify.recorded_args_sha256)} />
        <KvRow k="output sha256" v={chunkHash(verify.recorded_result_sha256)} />
        <KvDivider>Signature</KvDivider>
        <KvRow
          k="signature"
          v={
            verify.signature === "verified"
              ? "Ed25519 · valid"
              : verify.signature === "failed"
                ? "Ed25519 · invalid"
                : verify.signature === "no_receipt"
                  ? "—"
                  : "not yet signed"
          }
        />
        <KvRow
          k="signed by"
          v={verify.signature === "verified" ? "kx_inari-prod-2026" : "—"}
        />
        <KvDivider>Chain</KvDivider>
        <KvRow k="chain depth" v="—" />
        <KvRow k="chain parent" v="—" />
        <KvRow k="chain root" v="—" isLast />
      </div>
    </div>
  );
}

interface KvRowProps {
  k: string;
  v: string;
  sage?: boolean;
  isLast?: boolean;
}

function KvRow({ k, v, sage = false, isLast = false }: KvRowProps) {
  return (
    <div
      className="grid items-center px-4 py-2.5"
      style={{
        gridTemplateColumns: "120px 1fr auto",
        gap: 12,
        borderBottom: isLast ? "none" : "1px solid var(--border)",
      }}
    >
      <span className="text-[11.5px]" style={{ color: "var(--text-dim)" }}>
        {k}
      </span>
      <span
        className="text-[12px] truncate"
        style={{
          fontFamily: "var(--font-mono)",
          color: sage ? "var(--verified)" : "var(--text-muted)",
        }}
      >
        {v}
      </span>
      {v !== "—" ? (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(v);
          }}
          className="text-[10.5px] hover:text-[var(--text)] transition-colors opacity-0 hover:opacity-100"
          style={{ color: "var(--text-faint)" }}
          aria-label={`Copy ${k}`}
        >
          copy
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

function KvDivider({ children }: { children: ReactNode }) {
  return (
    <div
      className="px-4 py-2 text-[10.5px]"
      style={{
        background: "rgba(255,255,255,0.012)",
        color: "var(--text-faint)",
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {children}
    </div>
  );
}

interface JsonCardProps {
  title: string;
  json: string | null;
}

function ArgsCard({ entry }: { entry: AuditEntry }) {
  // Args are usually `{}` for cloud queries — start collapsed so they
  // don't take up vertical space when there's nothing to show.
  return <CollapsibleJsonCard title="Args" json={entry.args_json} />;
}

function OutputCard({ entry }: { entry: AuditEntry }) {
  // Output is the answer — always open by default. The pre-block has
  // its own `max-h-[200px]` cap so giant outputs don't blow out the
  // modal; users can scroll the JSON inside its card.
  return <CollapsibleJsonCard title="Output" json={entry.result_json} initiallyOpen />;
}

function CollapsibleJsonCard({ title, json, initiallyOpen = false }: JsonCardProps & { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const bytes = json ? new Blob([json]).size : 0;
  const summary = json ? summarizeJson(json) : "—";
  return (
    <div>
      <Eyebrow>{title}</Eyebrow>
      <div
        className="rounded-[10px] overflow-hidden mt-2.5"
        style={{
          border: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-white/[0.012] transition-colors"
          aria-expanded={open}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {open ? (
              <ChevronDown size={11} strokeWidth={2} style={{ color: "var(--text-dim)" }} />
            ) : (
              <ChevronRight size={11} strokeWidth={2} style={{ color: "var(--text-dim)" }} />
            )}
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
              {open ? "collapse" : "expand"}
            </span>
            <span style={{ color: "var(--text-faint)" }}>·</span>
            <span
              className="truncate"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                color: "var(--text-dim)",
              }}
            >
              {summary}
            </span>
          </div>
          <span
            className="text-[11px] shrink-0 ml-2"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
          >
            {bytes ? `${bytes} bytes` : ""}
          </span>
        </button>
        {open && json ? (
          <pre
            className="m-0 px-4 py-3 overflow-auto text-[11.5px] max-h-[200px]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              background: "rgba(0,0,0,0.18)",
              borderTop: "1px solid var(--border)",
            }}
          >
            {prettyJson(json)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

interface StatusPillProps {
  status: "done" | "failed" | "denied" | "pending";
}

function StatusPill({ status }: StatusPillProps) {
  const config = {
    done: {
      bg: "rgba(166,194,176,0.06)",
      border: "rgba(166,194,176,0.18)",
      color: "#BFD5C7",
      label: "done",
      icon: <Check size={9} strokeWidth={3} />,
    },
    failed: {
      bg: "rgba(208,133,133,0.07)",
      border: "rgba(208,133,133,0.22)",
      color: "#E0A8A8",
      label: "failed",
      icon: <X size={9} strokeWidth={3} />,
    },
    denied: {
      bg: "rgba(208,133,133,0.07)",
      border: "rgba(208,133,133,0.22)",
      color: "#E0A8A8",
      label: "denied",
      icon: <X size={9} strokeWidth={3} />,
    },
    pending: {
      bg: "rgba(212,180,122,0.07)",
      border: "rgba(212,180,122,0.20)",
      color: "#E2C58B",
      label: "pending",
      icon: null,
    },
  }[status];
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{
        height: 22,
        padding: "0 9px 0 8px",
        borderRadius: 999,
        background: config.bg,
        border: `1px solid ${config.border}`,
        color: config.color,
        fontSize: 11,
        lineHeight: 1,
      }}
    >
      {config.icon}
      {config.label}
    </span>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-[10.5px] font-medium"
      style={{
        color: "var(--text-faint)",
        letterSpacing: "0.16em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

interface CollapsibleSectionProps {
  title: string;
  summary: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Section with a clickable header that doubles as a one-line summary
 * when collapsed. Used to hide the noisy hash dump (Receipt header) by
 * default while keeping the trust signal one click away.
 */
function CollapsibleSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left focus:outline-none group"
      >
        {open ? (
          <ChevronDown
            size={11}
            strokeWidth={2}
            style={{ color: "var(--text-dim)" }}
          />
        ) : (
          <ChevronRight
            size={11}
            strokeWidth={2}
            style={{ color: "var(--text-dim)" }}
          />
        )}
        <Eyebrow>{title}</Eyebrow>
        {!open ? (
          <span
            className="ml-1 text-[11.5px]"
            style={{
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.005em",
            }}
          >
            {summary}
          </span>
        ) : null}
      </button>
      {open ? <div className="mt-2.5">{children}</div> : null}
    </div>
  );
}

function receiptSummary(verify: VerifyResult): ReactNode {
  const sig = verify.signature;
  const sigLabel =
    sig === "verified"
      ? "valid"
      : sig === "failed"
        ? "invalid"
        : sig === "no_receipt"
          ? "no receipt"
          : "not yet signed";
  return (
    <>
      Ed25519 <span style={{ color: "var(--text-faint)" }}>·</span>{" "}
      <span
        style={{
          color:
            sig === "verified"
              ? "var(--verified)"
              : sig === "failed"
                ? "var(--danger)"
                : "var(--text-dim)",
        }}
      >
        {sigLabel}
      </span>
    </>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
      {children}
    </span>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function deriveWitnessShort(invocationId: string): string {
  const stripped = invocationId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return `w_${stripped}`;
}

function shortHash(hex: string): string {
  if (!hex) return "(none)";
  if (hex.length <= 12) return hex;
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

function chunkHash(hex: string | null): string {
  if (!hex) return "—";
  if (hex.length < 32) return hex;
  // 8-char chunks separated by mid dot, like the design comp:
  // a4d1e9c2 · 7f81a209 · 3c0d6b1e · b7f2
  const chunks: string[] = [];
  for (let i = 0; i < hex.length && chunks.length < 4; i += 8) {
    chunks.push(hex.slice(i, i + 8));
  }
  return chunks.join(" · ");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function summarizeJson(raw: string): string {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
    if (typeof v === "object" && v !== null) {
      const keys = Object.keys(v).slice(0, 3);
      const preview = keys
        .map((k) => `${k}: ${typeof (v as Record<string, unknown>)[k] === "object" ? "{…}" : "…"}`)
        .join(", ");
      return `{ ${preview}${Object.keys(v).length > 3 ? ", …" : ""} }`;
    }
    return String(v);
  } catch {
    return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
  }
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function signatureCheckState(s: SignatureStatus): CheckState {
  if (s === "verified") return "ok";
  if (s === "failed") return "fail";
  return "neutral";
}

function signatureHelper(s: SignatureStatus): ReactNode {
  switch (s) {
    case "verified":
      return (
        <>
          signed by{" "}
          <Mono>kx_inari-prod-2026</Mono>{" "}
          <span style={{ color: "var(--text-faint)" }}>·</span>{" "}
          key trusted in this workspace
        </>
      );
    case "failed":
      return "Receipt signature did not validate — refuse to trust this row";
    case "no_receipt":
      return "This row has no linked witness receipt — cannot verify";
    case "not_yet_signed":
    default:
      return "Receipts pre-S6 carry only metadata — Ed25519 signature lands once the chat session owns the signing key.";
  }
}
