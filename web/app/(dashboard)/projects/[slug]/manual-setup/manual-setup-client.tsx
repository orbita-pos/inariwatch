"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Key,
  Laptop,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  HOSTS,
  HOST_TIERS,
  buildFrameworkSnippets,
  getHostMeta,
  type FrameworkId,
  type FrameworkSnippet,
  type HostId,
  type Tier,
} from "@/lib/hosts";

interface MintResponse {
  id:          string;
  token:       string;
  fingerprint: string;
  dsn:         string;
  created_at:  string;
  scope:       string[];
}

interface Props {
  projectId:         string;
  projectSlug:       string;
  repoFullName:      string | null;
  detectedFramework: FrameworkId;
  detectedHost:      HostId | null;
}

/**
 * Manual setup body — token reveal, framework + host tabs, live SSE
 * verification, soft Inari-Live nag.
 *
 * Security UX:
 *   * The plaintext token only enters this component once, in response
 *     to the user's "Generate setup token" click. After "I've copied
 *     it" the token is wiped from React state — refreshing or
 *     navigating away makes it irretrievable (Rollbar pattern).
 *   * Snippets render `<your token>` placeholders before mint and after
 *     dismissal. Between mint and dismissal they include the real DSN
 *     so the user can copy a working `.env.local` line straight from
 *     the page.
 *   * Host instructions reference `<token>` only, not the plaintext —
 *     the user copies the token banner separately. This bounds the
 *     surface area of the secret on the page.
 */
export function ManualSetupClient({
  projectId,
  projectSlug,
  repoFullName,
  detectedFramework,
  detectedHost,
}: Props) {
  const [framework, setFramework] = useState<FrameworkId>(detectedFramework);
  const [host, setHost] = useState<HostId | null>(detectedHost);
  const [mintState, setMintState] = useState<MintState>({ kind: "idle" });
  const [showFull, setShowFull] = useState(false);
  const [verified, setVerified] = useState(false);
  const [softNagDismissed, setSoftNagDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(NAG_KEY) === "1";
  });

  // Subscribe to the project SSE stream so first event flips ✓.
  // Same endpoint S3 ships for the desktop wizard.
  useEffect(() => {
    if (verified) return;
    const url = `/api/projects/${encodeURIComponent(projectId)}/event-stream`;
    const es  = new EventSource(url);
    const onFirst = () => setVerified(true);
    es.addEventListener("first_event", onFirst);
    return () => {
      es.removeEventListener("first_event", onFirst);
      es.close();
    };
  }, [projectId, verified]);

  // Synthesise the snippet based on the current framework + DSN. We
  // pass `<your DSN>` placeholder before mint / after dismiss so the
  // copy buttons still work without a fresh mint round-trip.
  const dsnForSnippet = mintState.kind === "shown" ? mintState.dsn : "<your DSN>";
  const snippet: FrameworkSnippet = useMemo(
    () => buildFrameworkSnippets(framework, dsnForSnippet),
    [framework, dsnForSnippet],
  );

  return (
    <div className="space-y-5">
      <TokenBanner
        projectId={projectId}
        state={mintState}
        setState={setMintState}
        showFull={showFull}
        toggleFull={() => setShowFull((v) => !v)}
      />

      {/* Step 1 — Framework picker */}
      <SetupSection
        title="1. Install + wire the SDK"
        subtitle="Pick the framework that matches your repo. We auto-detected — switch if needed."
      >
        <FrameworkTabs current={framework} onChange={setFramework} detected={detectedFramework} />
        <SnippetList snippet={snippet} mintShown={mintState.kind === "shown"} />
      </SetupSection>

      {/* Step 2 — Host instruction tabs */}
      <SetupSection
        title="2. Add INARIWATCH_DSN to your host"
        subtitle="Paste the token into your host's environment variables so deployed builds report errors."
      >
        <HostTabs current={host} onChange={setHost} detected={detectedHost} />
        {host ? <HostInstructions hostId={host} /> : <HostPickerPrompt />}
      </SetupSection>

      {/* Step 3 — Live verification */}
      <SetupSection
        title="3. Wait for first event"
        subtitle="This page updates the moment your deployed app sends its first error."
      >
        <VerificationStatus verified={verified} repoFullName={repoFullName} />
      </SetupSection>

      {!softNagDismissed ? (
        <SoftNag
          projectSlug={projectSlug}
          onDismiss={() => {
            window.localStorage.setItem(NAG_KEY, "1");
            setSoftNagDismissed(true);
          }}
        />
      ) : null}
    </div>
  );
}

// ── Token banner ────────────────────────────────────────────────────────────

const NAG_KEY = "inariwatch.manual_setup.soft_nag_dismissed";

type MintState =
  | { kind: "idle" }
  | { kind: "minting" }
  | (MintResponse & { kind: "shown" })
  | { kind: "dismissed"; fingerprint: string }
  | { kind: "error"; message: string };

function TokenBanner({
  projectId,
  state,
  setState,
  showFull,
  toggleFull,
}: {
  projectId: string;
  state: MintState;
  setState: (s: MintState) => void;
  showFull: boolean;
  toggleFull: () => void;
}) {
  const [copied, setCopied] = useState<"token" | "dsn" | null>(null);
  function copy(value: string, key: "token" | "dsn") {
    void navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1800);
  }

  if (state.kind === "idle" || state.kind === "minting" || state.kind === "error") {
    return (
      <div className="rounded-xl border border-line bg-surface p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface-dim shrink-0">
            <Key aria-hidden="true" className="h-5 w-5 text-fg-base/70" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg-strong">Generate a setup token</p>
            <p className="text-[12.5px] text-fg-base/60 mt-1 max-w-[480px]">
              We'll mint a fresh project token, show it once, and embed it in
              the snippets below. Lose it → rotate (it's not recoverable).
            </p>
            {state.kind === "error" ? (
              <p className="mt-2 text-[12px] text-red-600 dark:text-red-400 font-mono">
                {state.message}
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={state.kind === "minting"}
            onClick={async () => {
              setState({ kind: "minting" });
              try {
                const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tokens`, {
                  method:  "POST",
                  headers: { "Content-Type": "application/json" },
                  body:    JSON.stringify({ created_via: "web" }),
                });
                if (!res.ok) {
                  const body = await res.json().catch(() => ({}));
                  setState({ kind: "error", message: body.error ?? `Mint failed (${res.status})` });
                  return;
                }
                const data = (await res.json()) as MintResponse;
                setState({ ...data, kind: "shown" });
              } catch (e) {
                setState({
                  kind: "error",
                  message: e instanceof Error ? e.message : "Mint failed",
                });
              }
            }}
          >
            {state.kind === "minting" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                Generate token
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  if (state.kind === "dismissed") {
    return (
      <div className="rounded-xl border border-line bg-surface p-4 flex items-center gap-3">
        <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" aria-hidden="true" />
        <p className="text-[12.5px] text-fg-base/70 min-w-0">
          Token <code className="font-mono text-fg-base/90">{state.fingerprint}…</code>{" "}
          stored. Lost it? Rotate from{" "}
          <a className="text-inari-accent hover:underline" href="#tokens">
            project settings
          </a>
          .
        </p>
      </div>
    );
  }

  // state.kind === "shown" — render the one-time reveal panel.
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.05] p-5 space-y-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg-strong">Copy this token now</p>
          <p className="text-[12px] text-fg-base/60 mt-0.5">
            Only the SHA-256 hash is stored on our side. If you lose the
            plaintext you'll need to rotate, not recover.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            // Wipe plaintext before transitioning — the React tree
            // forgets it, refreshing the page doesn't bring it back.
            setState({ kind: "dismissed", fingerprint: state.fingerprint });
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-fg-base"
          title="I've copied it"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-1.5">
        <p className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-fg-base/50">
          Token
        </p>
        <div className="flex items-center gap-1.5">
          <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2.5 py-1.5 font-mono text-xs text-orange-600 dark:text-orange-400">
            {showFull ? state.token : maskedToken(state.token)}
          </code>
          <button
            type="button"
            onClick={toggleFull}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-fg-base"
            title={showFull ? "Hide" : "Reveal"}
          >
            {showFull ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => copy(state.token, "token")}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-fg-base"
            title="Copy token"
          >
            {copied === "token" ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-fg-base/50">
          DSN <span className="ml-1 normal-case tracking-normal text-fg-base/40">use this in .env.local</span>
        </p>
        <div className="flex items-center gap-1.5">
          <code className="flex-1 truncate rounded bg-surface-dim border border-line px-2.5 py-1.5 font-mono text-xs text-fg-base/70">
            {state.dsn}
          </code>
          <button
            type="button"
            onClick={() => copy(state.dsn, "dsn")}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-fg-base/60 hover:text-fg-base"
            title="Copy DSN"
          >
            {copied === "dsn" ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function maskedToken(plaintext: string): string {
  if (plaintext.length <= 24) return plaintext;
  return `${plaintext.slice(0, 18)}${"•".repeat(plaintext.length - 22)}${plaintext.slice(-4)}`;
}

// ── Section chrome ──────────────────────────────────────────────────────────

function SetupSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5 space-y-4">
      <div>
        <h2 className="text-[14px] font-semibold text-fg-strong tracking-tight">{title}</h2>
        <p className="text-[12.5px] text-fg-base/60 mt-1">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

// ── Framework tabs ──────────────────────────────────────────────────────────

const FRAMEWORKS: ReadonlyArray<{ id: FrameworkId; name: string }> = [
  { id: "next",    name: "Next.js" },
  { id: "express", name: "Express / Node" },
  { id: "vite",    name: "Vite / SPA" },
  { id: "other",   name: "Other" },
];

function FrameworkTabs({
  current,
  onChange,
  detected,
}: {
  current: FrameworkId;
  onChange: (id: FrameworkId) => void;
  detected: FrameworkId;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Framework">
      {FRAMEWORKS.map((f) => {
        const active = current === f.id;
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(f.id)}
            className="px-3 py-1.5 rounded-md text-[12.5px] transition-colors"
            style={{
              background: active ? "rgba(255,255,255,0.05)" : "transparent",
              border: `1px solid ${active ? "var(--inari-accent, var(--accent, #A6C2B0))" : "var(--border, rgba(255,255,255,0.1))"}`,
              color: active ? "var(--text, #fff)" : "var(--text-muted, rgba(255,255,255,0.55))",
            }}
          >
            {f.name}
            {detected === f.id && !active ? (
              <span className="ml-1.5 text-[10px] text-fg-base/40">detected</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function SnippetList({ snippet, mintShown }: { snippet: FrameworkSnippet; mintShown: boolean }) {
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-fg-base/65">{snippet.description}</p>
      {snippet.steps.map((step, i) => (
        <SnippetBlock
          key={`${snippet.id}-${i}`}
          label={
            step.kind === "shell"
              ? "Run in your terminal"
              : step.kind === "patch"
                ? `Edit ${step.file}`
                : `Add to ${step.file}`
          }
          body={step.body}
          masked={!mintShown && step.kind !== "shell"}
        />
      ))}
    </div>
  );
}

function SnippetBlock({
  label,
  body,
  masked,
}: {
  label: string;
  body: string;
  masked: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-line overflow-hidden bg-surface-dim/40">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-line-subtle">
        <span className="text-[11px] uppercase tracking-[0.16em] text-fg-base/50">
          {label}
        </span>
        <div className="flex items-center gap-2">
          {masked ? (
            <span className="text-[10.5px] text-amber-600 dark:text-amber-400">
              Mint a token to fill in the DSN
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(body);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-fg-base/60 hover:text-fg-base"
            title="Copy"
          >
            {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      </div>
      <pre className="m-0 px-3 py-3 font-mono text-[12px] text-fg-base/85 leading-[1.6] whitespace-pre-wrap break-all">
        {body}
      </pre>
    </div>
  );
}

// ── Host tabs ───────────────────────────────────────────────────────────────

function HostTabs({
  current,
  onChange,
  detected,
}: {
  current: HostId | null;
  onChange: (id: HostId | null) => void;
  detected: HostId | null;
}) {
  // Group by tier so the dropdown reads top-down: Tier 1, Tier 2, Tier 3.
  const ordered: ReadonlyArray<HostId> = [
    ...HOST_TIERS[1],
    ...HOST_TIERS[2],
    ...HOST_TIERS[3],
  ];
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Deploy host">
      {ordered.map((id) => {
        const meta = HOSTS[id];
        const active = current === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className="px-3 py-1.5 rounded-md text-[12.5px] transition-colors"
            style={{
              background: active ? "rgba(255,255,255,0.05)" : "transparent",
              border: `1px solid ${active ? "var(--inari-accent, var(--accent, #A6C2B0))" : "var(--border, rgba(255,255,255,0.1))"}`,
              color: active ? "var(--text, #fff)" : "var(--text-muted, rgba(255,255,255,0.55))",
            }}
          >
            <span>{meta.name}</span>
            <TierPill tier={meta.tier} />
            {detected === id && !active ? (
              <span className="ml-1.5 text-[10px] text-fg-base/40">detected</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function TierPill({ tier }: { tier: Tier }) {
  return (
    <span
      className="ml-1.5 rounded-full text-[9.5px] uppercase tracking-wider"
      style={{
        padding: "1px 4px",
        background: "rgba(255,255,255,0.05)",
        color: "var(--text-faint, rgba(255,255,255,0.45))",
      }}
    >
      T{tier}
    </span>
  );
}

function HostInstructions({ hostId }: { hostId: HostId }) {
  const meta = getHostMeta(hostId);
  if (!meta) return null;
  return (
    <div className="rounded-lg border border-line bg-surface-dim/40 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line-subtle">
        <span className="text-[11px] uppercase tracking-[0.16em] text-fg-base/50">
          {meta.name} · how to add
        </span>
        {meta.dashboardUrl ? (
          <a
            href={meta.dashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-[11.5px] text-inari-accent hover:underline"
          >
            Open dashboard ↗
          </a>
        ) : null}
      </div>
      <pre className="m-0 px-3 py-3 font-mono text-[12px] text-fg-base/85 leading-[1.6] whitespace-pre-wrap">
        {meta.instructions}
      </pre>
    </div>
  );
}

function HostPickerPrompt() {
  return (
    <div className="rounded-lg border border-dashed border-line/60 px-4 py-6 text-center text-[12.5px] text-fg-base/60">
      Pick your host above to see the env-var instructions.
    </div>
  );
}

// ── Verification + soft nag ─────────────────────────────────────────────────

function VerificationStatus({
  verified,
  repoFullName,
}: {
  verified: boolean;
  repoFullName: string | null;
}) {
  // Track elapsed time so the user sees this is alive even when no
  // event has arrived. Capped at 5 minutes (the plan's "soft window")
  // — past that we surface a hint to redeploy.
  const startedRef = useRef<number>(Date.now());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (verified) return;
    const id = setInterval(() => setTick((t) => t + 1), 5_000);
    return () => clearInterval(id);
  }, [verified]);
  const elapsedSec = Math.floor((Date.now() - startedRef.current) / 1000);
  const overSoftWindow = elapsedSec > 5 * 60;

  if (verified) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-3">
        <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" aria-hidden="true" />
        <p className="text-[13px] text-fg-strong font-medium">
          First event received — capture is live
          {repoFullName ? <> for <code className="font-mono text-[12px]">{repoFullName}</code></> : null}.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-dim/40 px-4 py-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-base/60 shrink-0" aria-hidden="true" />
        <p className="text-[12.5px] text-fg-base/70" data-testid="verify-pending">
          Waiting for the first event from your deployed app…
          <span className="ml-2 text-fg-base/40 font-mono text-[11.5px]">{formatElapsed(tick, elapsedSec)}</span>
        </p>
      </div>
      {overSoftWindow ? (
        <p className="text-[11.5px] text-fg-base/50">
          More than 5 minutes elapsed — redeploy your app so the new env var
          lands in the running build, then trigger any error path to confirm.
        </p>
      ) : null}
    </div>
  );
}

function formatElapsed(_tick: number, elapsedSec: number): string {
  if (elapsedSec < 60) return `${elapsedSec}s`;
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;
  return `${m}m ${s}s`;
}

function SoftNag({ projectSlug, onDismiss }: { projectSlug: string; onDismiss: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-surface-dim/40 p-4 flex items-start gap-3">
      <Laptop aria-hidden="true" className="h-4 w-4 text-fg-base/60 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-fg-strong font-medium">
          Inari Live makes this 1-click
        </p>
        <p className="text-[12px] text-fg-base/60 mt-1">
          The desktop app installs the SDK, mints your token, and writes
          everything for you — including .env.local — without touching git.
        </p>
        <div className="mt-2 flex items-center gap-3 text-[12px]">
          <a
            href="https://app.inariwatch.com/download"
            className="text-inari-accent hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Install Inari Live →
          </a>
          <span aria-hidden="true" className="text-fg-base/30">·</span>
          {/* Cancel link — same project, dismisses this banner forever via localStorage */}
          <button type="button" onClick={onDismiss} className="text-fg-base/50 hover:text-fg-base/80">
            Don't show again
          </button>
        </div>
      </div>
      {/* `projectSlug` reserved for a future deeplink (e.g. "Open in Inari Live") */}
      <span className="sr-only">{projectSlug}</span>
    </div>
  );
}
