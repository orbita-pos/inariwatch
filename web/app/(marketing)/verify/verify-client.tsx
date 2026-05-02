"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  encodeShareable,
  decodeShareable,
  parseErrorReason,
  parseReceipt,
  verify,
} from "@/lib/eap-verify";
import type { EapReceipt, VerifyOutcome } from "@/lib/eap-verify";

const SAMPLE_PLACEHOLDER = `{
  "version": "eap-1",
  "receipt_id": "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8",
  "merkle_root": "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8",
  "signed": true,
  "signature": "...",
  "public_key": "...",
  "attestor": "inariwatch"
}`;

interface ResultState {
  rawJson: string;
  outcome: VerifyOutcome;
  receipt: EapReceipt | null;
}

export function VerifyClient() {
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState<ResultState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Read /r/<base64> from the URL on first paint and verify directly
  // (shareable URL flow). The middleware rewrite already maps this to
  // the /verify route on `verify.inariwatch.com`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const path = window.location.pathname;
    const match = path.match(/^\/verify\/r\/([A-Za-z0-9_-]+)\/?$/);
    if (!match) return;
    const segment = match[1]!;
    const decoded = decodeShareable(segment);
    if (!decoded) {
      setError(
        "Shareable link could not be decoded. The URL may have been truncated or modified.",
      );
      return;
    }
    setText(decoded);
    runVerifySync(decoded);
  }, []);

  const runVerifySync = useCallback((raw: string) => {
    setError(null);
    if (!raw.trim()) {
      setResult(null);
      return;
    }
    const parsed = parseReceipt(raw);
    if (!("version" in parsed)) {
      setResult({
        rawJson: raw,
        outcome: { kind: "malformed", reason: parseErrorReason(parsed) },
        receipt: null,
      });
      return;
    }
    const outcome = verify(parsed);
    setResult({ rawJson: raw, outcome, receipt: parsed });
  }, []);

  const onFileChosen = useCallback(
    (file: File) => {
      file
        .text()
        .then((t) => {
          setText(t);
          runVerifySync(t);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        });
    },
    [runVerifySync],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) onFileChosen(file);
    },
    [onFileChosen],
  );

  const onTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
  }, []);

  const onVerifyClick = useCallback(() => {
    runVerifySync(text);
  }, [text, runVerifySync]);

  const onClear = useCallback(() => {
    setText("");
    setResult(null);
    setError(null);
  }, []);

  return (
    <div className="space-y-6">
      {/* ── Drop zone ──────────────────────────────────────────── */}
      <div
        data-testid="dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragOver
            ? "border-inari-accent bg-inari-accent/5"
            : "border-inari-border bg-inari-card"
        }`}
      >
        <p className="text-sm text-fg-muted">
          Drop a <code className="font-mono text-fg-strong">.eap.json</code>{" "}
          file here, or
        </p>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="mt-3 inline-flex items-center rounded-md bg-inari-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-inari-accent/90"
        >
          Choose file…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFileChosen(file);
            e.target.value = "";
          }}
        />
      </div>

      {/* ── Paste textarea ─────────────────────────────────────── */}
      <div>
        <label
          htmlFor="receipt-json"
          className="mb-2 block text-sm font-medium text-fg-strong"
        >
          Or paste JSON
        </label>
        <textarea
          id="receipt-json"
          data-testid="receipt-json"
          value={text}
          onChange={onTextChange}
          rows={10}
          spellCheck={false}
          placeholder={SAMPLE_PLACEHOLDER}
          className="block w-full resize-y rounded-md border border-inari-border bg-inari-card px-3 py-2 font-mono text-xs text-fg-strong outline-none focus:border-inari-accent"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="verify-button"
            onClick={onVerifyClick}
            disabled={!text.trim()}
            className="inline-flex items-center rounded-md bg-inari-accent px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-50"
          >
            Verify
          </button>
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center rounded-md border border-inari-border bg-inari-card px-4 py-2 text-sm font-medium text-fg-strong transition-colors hover:border-inari-accent/40"
          >
            Clear
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-400"
        >
          {error}
        </div>
      )}

      {result && <ResultBlock result={result} />}
    </div>
  );
}

function ResultBlock({ result }: { result: ResultState }) {
  const { outcome, receipt, rawJson } = result;
  const tone = outcomeTone(outcome);
  return (
    <div
      role="status"
      data-testid="verify-result"
      data-outcome={outcome.kind}
      className={`rounded-xl border p-6 ${tone.container}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wider ${tone.tag}`}>
            {tone.headline}
          </p>
          <p className="mt-1 text-base text-fg-strong">{summary(outcome)}</p>
        </div>
        <ShareButton rawJson={rawJson} />
      </div>

      {receipt && (
        <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-[max-content,1fr]">
          <Field label="version" value={receipt.version} />
          <Field label="receipt_id" value={receipt.receipt_id} mono />
          <Field label="merkle_root" value={receipt.merkle_root} mono />
          {receipt.attestor && (
            <Field label="attestor" value={receipt.attestor} />
          )}
          {receipt.public_key && (
            <Field label="public_key" value={receipt.public_key} mono />
          )}
          {(outcome.kind === "signed" ? outcome.key_id : receipt.key_id) && (
            <Field
              label="key_id"
              value={
                outcome.kind === "signed"
                  ? outcome.key_id
                  : (receipt.key_id ?? "")
              }
              mono
            />
          )}
          {receipt.timestamp && (
            <Field label="timestamp" value={receipt.timestamp} />
          )}
          {receipt.model && <Field label="model" value={receipt.model} />}
          {receipt.prompt_hash && (
            <Field label="prompt_hash" value={receipt.prompt_hash} mono />
          )}
          {receipt.recording_id && (
            <Field label="recording_id" value={receipt.recording_id} mono />
          )}
        </dl>
      )}
    </div>
  );
}

function ShareButton({ rawJson }: { rawJson: string }) {
  const [copied, setCopied] = useState(false);

  const url = useMemo(() => {
    if (typeof window === "undefined") return null;
    const segment = encodeShareable(rawJson);
    if (!segment) return null;
    const origin =
      window.location.host.startsWith("verify.")
        ? `${window.location.protocol}//${window.location.host}`
        : `${window.location.protocol}//${window.location.host}`;
    const path = window.location.host.startsWith("verify.")
      ? `/r/${segment}`
      : `/verify/r/${segment}`;
    return `${origin}${path}`;
  }, [rawJson]);

  if (!url) return null;
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof navigator === "undefined") return;
        navigator.clipboard
          .writeText(url)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
          })
          .catch(() => undefined);
      }}
      className="shrink-0 rounded-md border border-inari-border bg-inari-card px-3 py-1.5 text-xs font-medium text-fg-strong transition-colors hover:border-inari-accent/40"
    >
      {copied ? "Copied!" : "Share verification"}
    </button>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="font-medium text-fg-muted">{label}</dt>
      <dd
        className={`break-all ${mono ? "font-mono" : ""} text-fg-strong`}
      >
        {value}
      </dd>
    </>
  );
}

function outcomeTone(outcome: VerifyOutcome): {
  container: string;
  tag: string;
  headline: string;
} {
  switch (outcome.kind) {
    case "signed":
      return {
        container:
          "border-emerald-500/40 bg-emerald-500/5",
        tag: "text-emerald-400",
        headline: "Signature verified",
      };
    case "merkle-only":
      return {
        container: "border-sky-500/40 bg-sky-500/5",
        tag: "text-sky-400",
        headline: "Merkle-only — tamper-evident, no attestor identity",
      };
    case "signature-invalid":
      return {
        container: "border-red-500/40 bg-red-500/5",
        tag: "text-red-400",
        headline: "Signature invalid",
      };
    case "malformed":
      return {
        container: "border-red-500/40 bg-red-500/5",
        tag: "text-red-400",
        headline: "Malformed receipt",
      };
  }
}

function summary(outcome: VerifyOutcome): string {
  switch (outcome.kind) {
    case "signed":
      return `Ed25519 signature verifies against the embedded public key (key_id ${outcome.key_id}).`;
    case "merkle-only":
      return "No signature was minted. The Merkle root remains tamper-evident on its own — but cannot be tied back to a specific attestor identity.";
    case "signature-invalid":
      return "The Ed25519 signature does NOT verify against the embedded public key. The receipt has been tampered, or was not signed by the attestor whose key is embedded.";
    case "malformed":
      return outcome.reason;
  }
}
