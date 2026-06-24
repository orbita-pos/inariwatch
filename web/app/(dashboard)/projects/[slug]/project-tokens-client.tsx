"use client";

import { useState, useTransition } from "react";
import {
  Check,
  Copy,
  Key,
  Loader2,
  RotateCw,
  Trash2,
  Eye,
  EyeOff,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export type TokenView = {
  id:           string;
  fingerprint:  string;
  scope:        string[];
  createdAt:    string;
  lastUsedAt:   string | null;
  revokedAt:    string | null;
  rotatedTo:    string | null;
  createdVia:   string;
  deviceLabel:  string | null;
};

interface MintResponse {
  id:          string;
  token:       string;
  fingerprint: string;
  dsn:         string;
  created_at:  string;
  scope:       string[];
}

interface RotateResponse extends MintResponse {
  supersedes:    string;
  grace_ends_at: string;
}

interface Props {
  projectId:     string;
  isAdmin:       boolean;
  initialTokens: TokenView[];
}

/**
 * Project tokens panel UI (Inari Live V1 — Session 2).
 *
 * Lists tokens by fingerprint, lets admins mint/rotate/revoke. The plaintext
 * token is shown ONCE in a modal after mint or rotate; once dismissed it is
 * unrecoverable. Mirrors the "shown once" UX from MCP tokens + Rollbar.
 */
export function ProjectTokensClient({ projectId, isAdmin, initialTokens }: Props) {
  const [tokens, setTokens] = useState<TokenView[]>(initialTokens);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<
    | null
    | (MintResponse & { kind: "mint" | "rotate"; supersedes?: string; graceEndsAt?: string })
  >(null);
  const [copied, setCopied] = useState<"token" | "dsn" | null>(null);
  const [showFull, setShowFull] = useState(false);

  function copy(value: string, key: "token" | "dsn") {
    navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1800);
  }

  async function refresh() {
    const res = await fetch(`/api/projects/${projectId}/tokens`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setTokens(data.tokens ?? []);
  }

  function handleMint() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/projects/${projectId}/tokens`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ created_via: "web" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Mint failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as MintResponse;
      setRevealedToken({ ...data, kind: "mint" });
      setShowFull(false);
      await refresh();
    });
  }

  function handleRotate(tokenId: string, fingerprint: string) {
    if (!confirm(
      `Rotate token ${fingerprint}? The current token will keep working for 24 hours, then auto-revoke.`,
    )) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/projects/${projectId}/tokens/${tokenId}/rotate`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ created_via: "web" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Rotate failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as RotateResponse;
      setRevealedToken({
        ...data,
        kind:        "rotate",
        supersedes:  data.supersedes,
        graceEndsAt: data.grace_ends_at,
      });
      setShowFull(false);
      await refresh();
    });
  }

  function handleRevoke(tokenId: string, fingerprint: string) {
    if (!confirm(
      `Revoke token ${fingerprint}? This is immediate — any client still using it will start failing right away.`,
    )) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/projects/${projectId}/tokens/${tokenId}/revoke`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ reason: "revoked from dashboard" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Revoke failed (${res.status})`);
        return;
      }
      await refresh();
    });
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-5 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface-dim shrink-0">
            <Key aria-hidden="true" className="h-5 w-5 text-fg-base/70" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
              Project tokens
            </p>
            <p className="text-sm text-fg-base/70">
              {tokens.length === 0
                ? "No tokens yet — mint one to use the new bearer-auth Capture flow."
                : `${tokens.filter((t) => !t.revokedAt).length} active · ${tokens.length} total`}
            </p>
          </div>
        </div>

        {isAdmin && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="shrink-0"
            onClick={handleMint}
            disabled={isPending}
          >
            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Mint token"}
          </Button>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[12px] text-red-600 dark:text-red-400 font-mono">
          {error}
        </p>
      )}

      {tokens.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line overflow-hidden">
          {tokens.map((t) => {
            const status = tokenStatus(t);
            return (
              <li
                key={t.id}
                className="flex items-center gap-3 bg-surface-dim/40 px-3 py-2.5 text-[12px]"
              >
                <code className="font-mono text-fg-base/80 truncate">{t.fingerprint}…</code>
                <span className={statusPillClass(status)}>{status}</span>
                {t.deviceLabel && (
                  <span className="text-fg-base/50">{t.deviceLabel}</span>
                )}
                <span className="ml-auto text-fg-base/40">
                  {t.lastUsedAt
                    ? `last seen ${formatRelative(t.lastUsedAt)}`
                    : `created ${formatRelative(t.createdAt)}`}
                </span>
                {isAdmin && status === "active" && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleRotate(t.id, t.fingerprint)}
                      disabled={isPending}
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-fg-base hover:border-line-medium disabled:opacity-40"
                      title="Rotate (24h grace, then auto-revoke)"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevoke(t.id, t.fingerprint)}
                      disabled={isPending}
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-red-500 hover:border-red-500/40 disabled:opacity-40"
                      title="Revoke immediately"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-[11px] text-fg-base/40">
        Tokens use the <code className="font-mono">iwk_pub_v1_</code> prefix and are stored only as
        SHA-256 hashes — the plaintext is shown once on mint and is irretrievable after. Rotate
        to replace; revoke to invalidate immediately. The legacy DSN flow keeps working unchanged.
      </p>

      {revealedToken && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-line bg-surface p-5 space-y-4 shadow-xl">
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                {revealedToken.kind === "rotate" ? "Token rotated" : "Token minted"}
              </p>
              <p className="text-sm text-fg-base font-medium">
                Copy this token now — you won&apos;t see it again.
              </p>
            </div>

            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <p className="text-[11px] text-amber-700 dark:text-amber-300">
                Only the SHA-256 hash is stored on our side. If you lose the plaintext you&apos;ll
                need to rotate this token, not recover it.
              </p>
            </div>

            <div className="space-y-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                Token
              </p>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2.5 py-1.5 font-mono text-xs text-orange-600 dark:text-orange-400">
                  {showFull ? revealedToken.token : maskedToken(revealedToken.token)}
                </code>
                <button
                  type="button"
                  onClick={() => setShowFull((v) => !v)}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-fg-base"
                  title={showFull ? "Hide" : "Reveal"}
                >
                  {showFull ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => copy(revealedToken.token, "token")}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-fg-base"
                  title="Copy token"
                >
                  {copied === "token" ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                DSN <span className="ml-1 normal-case tracking-normal text-fg-base/40">backwards-compat URL form</span>
              </p>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2.5 py-1.5 font-mono text-xs text-fg-base/70">
                  {revealedToken.dsn}
                </code>
                <button
                  type="button"
                  onClick={() => copy(revealedToken.dsn, "dsn")}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-fg-base"
                  title="Copy DSN"
                >
                  {copied === "dsn" ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            {revealedToken.kind === "rotate" && revealedToken.graceEndsAt && (
              <p className="text-[11px] text-fg-base/50">
                The previous token keeps working until{" "}
                <span className="font-mono text-fg-base/70">
                  {new Date(revealedToken.graceEndsAt).toLocaleString()}
                </span>
                .
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => setRevealedToken(null)}
              >
                I&apos;ve copied it
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

type Status = "active" | "rotating" | "revoked";

function tokenStatus(t: TokenView): Status {
  if (t.revokedAt) return "revoked";
  if (t.rotatedTo) return "rotating";
  return "active";
}

function statusPillClass(s: Status): string {
  const base = "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium";
  switch (s) {
    case "active":
      return `${base} border-green-500/20 bg-green-500/[0.05] text-green-600 dark:text-green-400`;
    case "rotating":
      return `${base} border-amber-500/20 bg-amber-500/[0.05] text-amber-600 dark:text-amber-400`;
    case "revoked":
      return `${base} border-line bg-surface-dim text-fg-base/50`;
  }
}

function maskedToken(plaintext: string): string {
  // Show prefix + last 4 chars; mask the rest.
  if (plaintext.length <= 24) return plaintext;
  return `${plaintext.slice(0, 18)}${"•".repeat(plaintext.length - 22)}${plaintext.slice(-4)}`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 86_400_000 * 30) return `${Math.floor(ms / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
