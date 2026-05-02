import { Download, ExternalLink, Lock } from "lucide-react";
import { useMemo, useState } from "react";

import { Dialog, DialogClose, Button } from "@/components/ui";
import { exportEapReceipt, type EapReceiptDto } from "@/lib/dock-ipc";
import { cn } from "@/lib/cn";

interface EAPReceiptChipProps {
  /** Mirrored EAP receipt for the current remediation session. `null` => unsigned chip. */
  receipt: EapReceiptDto | null;
  /** When true the chip renders compact (used inline beside the Replay button). */
  compact?: boolean;
}

/** Status the Export button surfaces below the action row. */
type ExportFeedback =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; path: string; merkleOnly: boolean }
  | { kind: "error"; message: string };

/**
 * Sesión 28 — call `export_eap_receipt`. The native save-dialog runs
 * server-side (same pattern as `desktop_pick_watch_dir`), so the
 * frontend ships ZERO new deps. The IPC returns:
 *   - `kind: "ok"`        — file written; show success row.
 *   - `kind: "cancelled"` — user dismissed picker; return to idle.
 *   - `kind: "error"`     — write failure; show error row.
 */
async function exportReceiptToDisk(
  receipt: EapReceiptDto,
): Promise<ExportFeedback> {
  const result = await exportEapReceipt(receipt.remediationSessionId);
  if (result.kind === "ok") {
    return {
      kind: "saved",
      path: result.path,
      merkleOnly: !result.hasPublicKey,
    };
  }
  if (result.kind === "cancelled") {
    return { kind: "idle" };
  }
  return { kind: "error", message: result.message };
}

/**
 * Sesión 27 — the trust chip. When `receipt` is null we show an
 * "Unsigned" affordance (matches the legacy `EapIndicator` posture so
 * unattested fixes don't suddenly look broken). When a receipt exists
 * we render a hover/focus chip with the truncated Merkle root; click
 * opens a detail dialog with prompt hash, system prompt, tools called,
 * files read, signature, and a deep link to `verify.inariwatch.com`.
 *
 * The dialog parses `tools_called_json` / `files_read_json` defensively
 * — the wire format is intentionally JSON strings (Sesión 27 spec) so
 * the rust IPC stays schema-agnostic. A malformed payload renders the
 * raw string with a "could not parse" hint instead of crashing.
 */
export function EAPReceiptChip({ receipt, compact = false }: EAPReceiptChipProps) {
  const [open, setOpen] = useState(false);
  const [exportState, setExportState] = useState<ExportFeedback>({ kind: "idle" });

  async function handleExport() {
    if (!receipt) return;
    setExportState({ kind: "saving" });
    const next = await exportReceiptToDisk(receipt);
    setExportState(next);
  }

  if (!receipt) {
    return (
      <span
        data-testid="eap-receipt-chip"
        data-eap-state="unsigned"
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5",
          "rounded-[var(--radius-sm)] border border-[var(--border)]",
          "bg-[var(--surface)] text-xs font-[var(--font-mono)]",
          "text-[var(--muted)]",
        )}
      >
        <Lock className="h-3 w-3" aria-hidden />
        Unsigned
      </span>
    );
  }

  const truncated = truncateHash(receipt.merkleRoot);
  const stateAttr = receipt.signed ? "signed" : "merkle_only";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="eap-receipt-chip"
        data-eap-state={stateAttr}
        title={`EAP receipt — Merkle root ${truncated}`}
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5",
          "rounded-[var(--radius-sm)] border",
          "bg-[var(--surface)] text-xs font-[var(--font-mono)]",
          "transition-colors duration-[var(--duration-fast)]",
          receipt.signed
            ? "border-[var(--color-primary)] text-[var(--color-primary)]"
            : "border-[var(--border)] text-[var(--muted)]",
          "hover:brightness-110",
        )}
      >
        <Lock className="h-3 w-3" aria-hidden />
        {compact ? truncated : <>EAP {truncated}</>}
      </button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="EAP attestation receipt"
        description={
          receipt.signed
            ? "Cryptographically signed (Ed25519). The Merkle root and signature can be re-verified independently at verify.inariwatch.com."
            : "Merkle root only — no Ed25519 signature was minted (the EAP server was deployed without an attestor keypair). The Merkle root is still tamper-evident."
        }
      >
        <ReceiptDetail receipt={receipt} />
        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <a
              href={`https://verify.inariwatch.com/r/${encodeURIComponent(receipt.receiptId)}`}
              target="_blank"
              rel="noreferrer"
              data-testid="eap-receipt-chip-verify-link"
              className={cn(
                "inline-flex items-center gap-1 text-xs text-[var(--color-primary)]",
                "hover:underline",
              )}
            >
              <ExternalLink className="h-3 w-3" aria-hidden /> Open in verifier
            </a>
            <button
              type="button"
              onClick={handleExport}
              disabled={exportState.kind === "saving"}
              data-testid="eap-receipt-chip-export"
              className={cn(
                "inline-flex items-center gap-1 text-xs text-[var(--muted)]",
                "hover:text-[var(--color-primary)] hover:underline",
                "disabled:opacity-60 disabled:cursor-progress",
              )}
            >
              <Download className="h-3 w-3" aria-hidden />
              {exportState.kind === "saving" ? "Saving…" : "Export receipt"}
            </button>
          </div>
          <DialogClose asChild>
            <Button size="sm" variant="ghost">
              Close
            </Button>
          </DialogClose>
        </div>
        <ExportStatusLine state={exportState} />
      </Dialog>
    </>
  );
}

interface ReceiptDetailProps {
  receipt: EapReceiptDto;
}

function ReceiptDetail({ receipt }: ReceiptDetailProps) {
  const tools = useParsedJsonArray(receipt.toolsCalledJson);
  const files = useParsedJsonArray(receipt.filesReadJson);

  return (
    <dl
      data-testid="eap-receipt-detail"
      className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-xs"
    >
      <Field label="Receipt ID" mono>
        {receipt.receiptId}
      </Field>
      <Field label="Merkle root" mono>
        {receipt.merkleRoot}
      </Field>
      {receipt.promptHash ? (
        <Field label="Prompt hash" mono>
          {receipt.promptHash}
        </Field>
      ) : null}
      {receipt.model ? <Field label="Model">{receipt.model}</Field> : null}
      <Field label="Attestor">{receipt.attestor}</Field>
      <Field label="Timestamp">{formatMs(receipt.createdAtMs)}</Field>
      {receipt.systemPrompt ? (
        <Field label="System prompt">
          <PreBlock text={receipt.systemPrompt} max={400} />
        </Field>
      ) : null}
      {tools.length > 0 ? (
        <Field label="Tools called">
          <ul className="list-disc list-inside space-y-0.5">
            {tools.map((tool, idx) => (
              <li key={idx} className="font-[var(--font-mono)] truncate">
                {summarizeTool(tool)}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
      {files.length > 0 ? (
        <Field label="Files read">
          <ul className="list-disc list-inside space-y-0.5">
            {files.map((f, idx) => (
              <li key={idx} className="font-[var(--font-mono)] truncate">
                {typeof f === "string" ? f : JSON.stringify(f)}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
      {receipt.signature ? (
        <Field label="Signature" mono>
          <PreBlock text={receipt.signature} max={160} />
        </Field>
      ) : (
        <Field label="Signature">
          <span className="text-[var(--muted)]">none (Merkle-only receipt)</span>
        </Field>
      )}
    </dl>
  );
}

interface FieldProps {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}

function Field({ label, mono = false, children }: FieldProps) {
  return (
    <>
      <dt className="text-[var(--muted)] uppercase tracking-wide text-[0.65rem] pt-0.5">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 break-all",
          mono ? "font-[var(--font-mono)]" : "",
        )}
      >
        {children}
      </dd>
    </>
  );
}

function PreBlock({ text, max }: { text: string; max: number }) {
  const trimmed = text.length > max ? `${text.slice(0, max)}…` : text;
  return (
    <pre className="whitespace-pre-wrap break-all text-[0.65rem] leading-snug">
      {trimmed}
    </pre>
  );
}

function truncateHash(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "unknown";
  try {
    return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  } catch {
    return "unknown";
  }
}

function useParsedJsonArray(raw: string): unknown[] {
  return useMemo(() => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [raw]);
}

/**
 * Sesión 28 — small status row under the action buttons. Surfaces the
 * outcome of the most recent Export click so the user knows whether
 * the file was written and whether it carries a verifiable signature
 * (or is Merkle-only because the EAP server's pubkey was unavailable
 * at export time).
 */
function ExportStatusLine({ state }: { state: ExportFeedback }) {
  if (state.kind === "idle" || state.kind === "saving") return null;

  if (state.kind === "saved") {
    return (
      <p
        data-testid="eap-receipt-chip-export-status"
        className="mt-2 text-[0.65rem] text-[var(--muted)] break-all"
      >
        {state.merkleOnly
          ? `Saved (Merkle-only — attestor pubkey unavailable). ${state.path}`
          : `Saved. Verify offline: \`inari verify "${state.path}"\``}
      </p>
    );
  }
  return (
    <p
      data-testid="eap-receipt-chip-export-status"
      className="mt-2 text-[0.65rem] text-red-500 break-all"
      role="alert"
    >
      Export failed: {state.message}
    </p>
  );
}

function summarizeTool(tool: unknown): string {
  if (typeof tool === "string") return tool;
  if (typeof tool === "object" && tool !== null) {
    const obj = tool as Record<string, unknown>;
    const name =
      typeof obj.name === "string"
        ? obj.name
        : typeof obj.tool === "string"
          ? obj.tool
          : "(tool)";
    const args = obj.args ?? obj.input ?? null;
    if (args == null) return name;
    const stringified = JSON.stringify(args);
    const truncated =
      stringified.length > 80 ? `${stringified.slice(0, 80)}…` : stringified;
    return `${name}(${truncated})`;
  }
  return JSON.stringify(tool);
}
