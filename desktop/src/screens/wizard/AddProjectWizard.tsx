import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Boxes,
  Check,
  CheckCircle2,
  Cloud,
  ClipboardCopy,
  Container,
  ExternalLink,
  FolderTree,
  Globe,
  Loader2,
  RefreshCw,
  Server,
  Terminal,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui";
import { useWizard, WIZARD_STEPS, type WizardStep } from "@/lib/store/wizard";
import {
  HOSTS,
  HOST_TIERS,
  getHostMeta,
} from "@/lib/wizard/hosts";
import { WizardFrame } from "./WizardFrame";

const STEP_LABELS: Record<WizardStep, string> = {
  detect: "Detect",
  plan: "Plan",
  install: "Install",
  "host-sync": "Host",
  "run-dev": "Run dev",
  verify: "Verify",
};

/**
 * Inari Live V1 — Session 3 Add-Project wizard.
 *
 * Reads its active payload + step from the Zustand store
 * (`@/lib/store/wizard`). Each step is a small subcomponent so the
 * frame stays a thin shell and Vitest tests can mount steps in
 * isolation.
 *
 * Design system reuse:
 *   * `WizardFrame` — same chrome as `OnboardingFrame` (extracted so
 *     onboarding + this wizard share one source of truth).
 *   * Lucide icons + the `--accent` / `--text-*` semantic CSS vars.
 *   * `Button` from `@/components/ui` (no raw `<button>`).
 *
 * The wizard auto-mounts via `MainBoot` watching the `wizard:opened`
 * Tauri event. It also self-initialises via `useWizard.initialize()`
 * which polls `wizardGetPending` so a webview that booted AFTER the
 * relay dispatched the payload still picks it up.
 */
export function AddProjectWizard() {
  const wizard = useWizard();
  const [closing, setClosing] = useState(false);

  // First-mount initialise — wires the progress listener once per
  // app session and pulls any pending payload into state.
  useEffect(() => {
    void wizard.initialize();
    // We intentionally run this only on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to the project SSE stream once the install step starts.
  // The web side fires `first_event` when a real or test event arrives;
  // we mark the wizard verified so the verify step transitions
  // automatically. S4 — also subscribe during `host-sync` so the
  // 5-min "soft watch" works while the user is pasting the token into
  // their host's dashboard.
  useEffect(() => {
    if (!wizard.payload) return;
    if (
      wizard.step !== "verify" &&
      wizard.step !== "run-dev" &&
      wizard.step !== "host-sync"
    ) {
      return;
    }
    let aborted = false;
    let es: EventSource | null = null;
    const start = async () => {
      const url = await resolveEventStreamUrl(wizard.payload!.projectId);
      if (aborted || !url) return;
      es = new EventSource(url, { withCredentials: false });
      es.addEventListener("first_event", () => wizard.markVerified());
    };
    void start();
    return () => {
      aborted = true;
      if (es) es.close();
    };
  }, [wizard.payload, wizard.step]);

  if (!wizard.payload) {
    // Nothing to render — host should hide the wizard surface.
    return null;
  }

  const stepIndex = WIZARD_STEPS.indexOf(wizard.step);

  return (
    <WizardFrame
      subtitle="add project"
      steps={WIZARD_STEPS.map((s) => STEP_LABELS[s])}
      currentStep={stepIndex}
      testId="wizard-add-project"
      actionBar={
        <ActionBar
          closing={closing}
          onClose={async () => {
            setClosing(true);
            await wizard.dismiss();
            setClosing(false);
          }}
        />
      }
    >
      <div className="absolute inset-0 overflow-auto">
        <div className="max-w-[640px] mx-auto pt-12 pb-10 px-8">
          <RepoHeader />
          {wizard.step === "detect"    ? <DetectStep /> : null}
          {wizard.step === "plan"      ? <PlanStep />   : null}
          {wizard.step === "install"   ? <InstallStep /> : null}
          {wizard.step === "host-sync" ? <HostSyncStep /> : null}
          {wizard.step === "run-dev"   ? <RunDevStep />  : null}
          {wizard.step === "verify"    ? <VerifyStep />  : null}
        </div>
      </div>
    </WizardFrame>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────

function RepoHeader() {
  const payload = useWizard((s) => s.payload);
  if (!payload) return null;
  return (
    <div className="mb-8">
      <Eyebrow>Add Project</Eyebrow>
      <h2
        className="text-[26px] font-light tracking-[-0.02em] mt-3 flex items-center gap-3"
        style={{ color: "var(--text)" }}
      >
        <FolderTree size={18} strokeWidth={1.5} style={{ color: "var(--text-muted)" }} />
        <span style={{ fontFamily: "var(--font-mono)" }}>{payload.repoFullName}</span>
      </h2>
      <p
        className="text-[13px] mt-2 leading-[1.65]"
        style={{ color: "var(--text-subtle)" }}
      >
        Inari Live will install <code className="font-mono">@inariwatch/capture</code>,
        wire your env vars, and verify a first event — without touching git.
      </p>
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
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

// ── Step 1 — Detect ─────────────────────────────────────────────────────────

function DetectStep() {
  const wizard = useWizard();
  const detection = wizard.detection;

  return (
    <Card>
      <CardHead icon={<FolderTree size={14} strokeWidth={1.6} />} title="Looking for your local clone">
        Searched <code className="font-mono">~/code</code>, <code className="font-mono">~/dev</code>,{" "}
        <code className="font-mono">~/Documents/projects</code> and more.
      </CardHead>
      {detection?.path ? (
        <div className="mt-4 flex items-center gap-3">
          <CheckCircle2 size={16} style={{ color: "var(--verified, #A6C2B0)" }} />
          <span className="text-[12.5px]" style={{ fontFamily: "var(--font-mono)" }}>
            {detection.path}
          </span>
          <span
            className="ml-auto rounded-full border px-2 py-0.5 text-[11px]"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-muted)",
            }}
          >
            {detection.framework ?? "node"}
          </span>
        </div>
      ) : (
        <div className="mt-4">
          <p className="text-[12.5px]" style={{ color: "var(--text-subtle)" }}>
            No clone matched. Paste an absolute path to use:
          </p>
          <PathOverrideInput />
        </div>
      )}
      <div className="mt-6 flex items-center gap-3">
        <Button size="sm" variant="secondary" onClick={() => void wizard.runDetect()}>
          <RefreshCw size={12} aria-hidden="true" /> Re-scan
        </Button>
        {detection?.path ? (
          <Button size="sm" variant="primary" onClick={() => wizard.setStep("plan")}>
            Continue <ArrowRight size={12} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function PathOverrideInput() {
  const setPathOverride = useWizard((s) => s.setPathOverride);
  const setStep = useWizard((s) => s.setStep);
  const [draft, setDraft] = useState("");
  return (
    <div className="mt-3 flex items-center gap-2">
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="/absolute/path/to/repo"
        className="flex-1 h-9 px-3 rounded-md outline-none"
        style={{
          background: "rgba(255,255,255,0.025)",
          border: "1px solid var(--border-strong)",
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          color: "var(--text)",
        }}
      />
      <Button
        size="sm"
        variant="primary"
        disabled={draft.trim().length === 0}
        onClick={() => {
          setPathOverride(draft.trim());
          setStep("plan");
        }}
      >
        Use folder
      </Button>
    </div>
  );
}

// ── Step 2 — Plan ───────────────────────────────────────────────────────────

function PlanStep() {
  const wizard = useWizard();
  const detection = wizard.detection;
  const path = wizard.pathOverride ?? detection?.path ?? "";
  const framework = detection?.framework ?? "node";
  const host = detection?.host ?? wizard.payload?.host ?? null;
  const targetVercel = host === "vercel";
  const hostMeta = getHostMeta(host);

  const plan = useMemo(() => [
    `npm install @inariwatch/capture in ${path}`,
    `Patch ${frameworkPatchTarget(framework)} (${framework})`,
    `Write INARIWATCH_DSN to .env.local`,
    `Mint a fresh project token (S2)`,
    targetVercel
      ? `Sync DSN to Vercel env (production / preview / development)`
      : hostMeta
        ? `Show ${hostMeta.name} setup steps (next screen)`
        : `Show host setup steps (we'll detect on the next screen)`,
    `Backup token to OS keyring`,
  ], [path, framework, targetVercel, hostMeta]);

  return (
    <Card>
      <CardHead icon={<Terminal size={14} strokeWidth={1.6} />} title="Here's what I'll do">
        Wizard never touches git — your working tree stays dirty. Cancel any time.
      </CardHead>
      <ol className="mt-5 space-y-2">
        {plan.map((line, i) => (
          <li
            key={i}
            className="flex items-start gap-3 text-[12.5px] leading-[1.6]"
            style={{ color: "var(--text-muted)" }}
          >
            <span
              className="shrink-0 mt-0.5 inline-flex items-center justify-center rounded-full text-[10px]"
              style={{
                width: 18,
                height: 18,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid var(--border-strong)",
                fontFamily: "var(--font-mono)",
                color: "var(--text-dim)",
              }}
            >
              {i + 1}
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ol>
      <div className="mt-7 flex items-center gap-3">
        <Button size="sm" variant="secondary" onClick={() => wizard.setStep("detect")}>
          Back
        </Button>
        <Button size="sm" variant="primary" onClick={() => void wizard.runInstall()}>
          Run install <ArrowRight size={12} aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}

function frameworkPatchTarget(framework: string): string {
  switch (framework) {
    case "next":    return "next.config.ts + instrumentation.ts";
    case "vite":    return "src/main.ts (or src/index.ts)";
    case "express":
    case "node":    return "instrumentation.ts";
    default:        return "config";
  }
}

// ── Step 3 — Install (live progress) ────────────────────────────────────────

function InstallStep() {
  const fraction = useWizard((s) => s.fraction);
  const log = useWizard((s) => s.log);
  const error = useWizard((s) => s.error);
  const install = useWizard((s) => s.install);

  return (
    <Card>
      <CardHead icon={<Loader2 size={14} strokeWidth={1.6} className="animate-spin" />} title="Installing…">
        Live progress from the wizard pipeline. Logs persist after the wizard closes.
      </CardHead>
      <ProgressBar fraction={fraction} />
      <LogTail entries={log} />
      {error ? <ErrorBlock message={error} /> : null}
      {install ? (
        <div className="mt-4 text-[12.5px]" style={{ color: "var(--text)" }}>
          {install.adopted ? "Adopted existing capture install. " : "Install complete. "}
          Token <code className="font-mono">{install.fingerprint}</code>
          {install.vercel_synced
            ? <> · Vercel envs updated</>
            : install.vercel_warning
              ? <> · Vercel sync skipped: <span style={{ color: "var(--text-dim)" }}>{install.vercel_warning}</span></>
              : null}
        </div>
      ) : null}
    </Card>
  );
}

// ── Step 4 — Host sync (Inari Live V1 — Session 4) ──────────────────────────
//
// For Tier 1 (Vercel + sync ok) the wizard advances PAST this step
// directly to run-dev, so this UI only renders for Tier 2 / Tier 3 /
// universal-escape hosts.

function HostSyncStep() {
  const wizard       = useWizard();
  const hostId       = wizard.hostOverride ?? wizard.detection?.host ?? null;
  const meta         = getHostMeta(hostId);
  const tier         = meta?.tier ?? null;
  const installed    = wizard.install;
  const ack          = wizard.hostAcknowledged;
  const clipboard    = wizard.clipboardStatus;

  // Auto-copy to clipboard when entering the step for Tier 2 hosts —
  // the user expects "I clicked Add → token's in my clipboard" without
  // an extra click. Tier 3 users still get an explicit Copy button
  // because the snippet block is the source of truth.
  useEffect(() => {
    if (tier === 2 && installed && clipboard === "idle") {
      void wizard.copyTokenToClipboard();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, installed, clipboard]);

  return (
    <Card>
      <CardHead
        icon={<Cloud size={14} strokeWidth={1.6} />}
        title={
          meta
            ? `Detected: ${meta.name}`
            : "Pick your host"
        }
      >
        {meta
          ? "Set INARIWATCH_DSN as an env var on your host. We'll watch for the first event from your deployed app."
          : "We couldn't detect your host from the repo files. Pick from the list below — or run install on Vercel for the auto-sync path."}
      </CardHead>

      {/* Universal escape — host dropdown. Always rendered when no host
          was detected; also exposed as a "wrong host?" toggle on Tier 2/3 */}
      {!meta || wizard.hostOverride !== null ? <HostDropdown /> : null}

      {meta?.tier === 2 ? <Tier2Body /> : null}
      {meta?.tier === 3 ? <Tier3Body /> : null}

      {/* The action footer differs based on whether the user has
          acknowledged the manual setup. */}
      <div className="mt-7 flex items-center gap-3">
        <Button size="sm" variant="secondary" onClick={() => wizard.setStep("install")}>
          Back
        </Button>
        {meta ? (
          <Button
            size="sm"
            variant="primary"
            disabled={ack}
            onClick={() => wizard.acknowledgeHostSetup()}
          >
            <Check size={12} aria-hidden="true" />
            {ack ? "Marked ✓" : "I've added it"}
          </Button>
        ) : (
          <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>
            Pick a host above to continue.
          </span>
        )}
        <button
          type="button"
          className="ml-auto text-[11.5px]"
          style={{ color: "var(--text-faint)" }}
          onClick={() => wizard.setStep("run-dev")}
        >
          Skip — I'll set this up later →
        </button>
      </div>
    </Card>
  );
}

function HostDropdown() {
  const setHost = useWizard((s) => s.setHostOverride);
  const cur     = useWizard((s) => s.hostOverride);

  return (
    <div
      className="mt-4 p-3"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid var(--border-strong)",
        borderRadius: 8,
      }}
    >
      <p className="text-[11.5px] uppercase tracking-[0.16em]" style={{ color: "var(--text-faint)" }}>
        Choose your host
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {[...HOST_TIERS[2], ...HOST_TIERS[3]].map((id) => {
          const meta = HOSTS[id];
          const Icon = iconForHost(meta.icon ?? null);
          const active = cur === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setHost(id)}
              className="flex items-center gap-2.5 px-3 py-2 text-left transition-colors"
              style={{
                background: active ? "rgba(255,255,255,0.05)" : "transparent",
                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 6,
                color: active ? "var(--text)" : "var(--text-muted)",
                fontSize: 12.5,
              }}
            >
              <Icon size={13} strokeWidth={1.6} />
              <span>{meta.name}</span>
              <span
                className="ml-auto text-[10px] uppercase tracking-wider"
                style={{ color: "var(--text-faint)" }}
              >
                T{meta.tier}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type HostIconName = "Globe" | "Cloud" | "Server" | "Container" | "Boxes";

function iconForHost(name: HostIconName | null) {
  switch (name) {
    case "Globe":     return Globe;
    case "Cloud":     return Cloud;
    case "Server":    return Server;
    case "Container": return Container;
    case "Boxes":     return Boxes;
    default:          return Server;
  }
}

function Tier2Body() {
  const wizard    = useWizard();
  const hostId    = wizard.hostOverride ?? wizard.detection?.host ?? null;
  const meta      = getHostMeta(hostId);
  const clipboard = wizard.clipboardStatus;

  if (!meta) return null;
  return (
    <div className="mt-5 space-y-4">
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
          style={{
            background:
              clipboard === "copied"
                ? "rgba(166,194,176,0.12)"
                : clipboard === "error"
                  ? "rgba(226,111,111,0.10)"
                  : "rgba(255,255,255,0.04)",
            border: "1px solid var(--border-strong)",
            color:
              clipboard === "copied"
                ? "var(--verified, #A6C2B0)"
                : clipboard === "error"
                  ? "var(--danger, #E26F6F)"
                  : "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <ClipboardCopy size={11} aria-hidden="true" />
          {clipboard === "copied"
            ? "Token copied to clipboard"
            : clipboard === "error"
              ? "Copy failed — re-try"
              : "Copying token…"}
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void wizard.copyTokenToClipboard()}
        >
          <ClipboardCopy size={12} aria-hidden="true" />
          {clipboard === "copied" ? "Copy again" : "Copy token"}
        </Button>
      </div>

      {meta.dashboardUrl ? (
        <div>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void wizard.openHostDashboard()}
          >
            <ExternalLink size={12} aria-hidden="true" />
            Open {meta.name} dashboard
          </Button>
          {meta.dashboardHint ? (
            <p
              className="mt-2 text-[11.5px]"
              style={{ color: "var(--text-faint)", lineHeight: 1.55 }}
            >
              {meta.dashboardHint}
            </p>
          ) : null}
        </div>
      ) : null}

      <pre
        className="p-3 text-[11.5px] whitespace-pre-wrap"
        style={{
          background: "rgba(0,0,0,0.18)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          fontFamily: "var(--font-mono)",
          lineHeight: 1.55,
          color: "var(--text-muted)",
        }}
      >
        {meta.instructions}
      </pre>
    </div>
  );
}

function Tier3Body() {
  const wizard  = useWizard();
  const hostId  = wizard.hostOverride ?? wizard.detection?.host ?? null;
  const meta    = getHostMeta(hostId);
  const [showAll, setShowAll] = useState(false);

  if (!meta) return null;

  // The dropdown is "the picker", but Tier 3 users sometimes target
  // multiple deploy styles in one repo (Dockerfile + K8s manifests).
  // "Show all styles" expands a list of alternates.
  const others = HOST_TIERS[3].filter((id) => id !== meta.id);

  return (
    <div className="mt-5 space-y-4">
      <pre
        className="p-3 text-[11.5px] whitespace-pre-wrap"
        style={{
          background: "rgba(0,0,0,0.18)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          fontFamily: "var(--font-mono)",
          lineHeight: 1.55,
          color: "var(--text-muted)",
        }}
      >
        {meta.instructions}
      </pre>

      <Tier3CopyRow />

      <button
        type="button"
        className="text-[11.5px]"
        style={{ color: "var(--text-faint)" }}
        onClick={() => setShowAll((v) => !v)}
      >
        {showAll ? "Hide other styles ↑" : "Show all styles (Docker / K8s / systemd / PM2 / Other) ↓"}
      </button>

      {showAll ? (
        <ul className="space-y-2">
          {others.map((id) => {
            const otherMeta = HOSTS[id];
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => wizard.setHostOverride(id)}
                  className="text-left text-[12px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  → Switch to {otherMeta.name}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function Tier3CopyRow() {
  const wizard    = useWizard();
  const clipboard = wizard.clipboardStatus;

  return (
    <div className="flex items-center gap-3">
      <Button
        size="sm"
        variant="primary"
        onClick={() => void wizard.copyTokenToClipboard()}
      >
        <ClipboardCopy size={12} aria-hidden="true" />
        {clipboard === "copied" ? "Token copied ✓" : "Copy token to clipboard"}
      </Button>
      {clipboard === "error" ? (
        <span
          className="text-[11.5px]"
          style={{ color: "var(--danger, #E26F6F)" }}
        >
          Copy failed — try again
        </span>
      ) : null}
    </div>
  );
}

// ── Step 5 — Run dev ────────────────────────────────────────────────────────

function RunDevStep() {
  const wizard = useWizard();
  const fraction = wizard.fraction;
  const log = wizard.log;
  const runDev = wizard.runDev;
  const error = wizard.error;
  const inFlight = !runDev && fraction > 0 && fraction < 1;

  return (
    <Card>
      <CardHead icon={<Terminal size={14} strokeWidth={1.6} />} title="Run dev now">
        I'll spawn <code className="font-mono">npm run dev</code> in your repo and inject a test event
        once it's ready. The dev server keeps running after.
      </CardHead>
      {!runDev ? (
        <div className="mt-5 flex items-center gap-3">
          <Button
            size="sm"
            variant="primary"
            disabled={inFlight}
            onClick={() => void wizard.runDevServer()}
          >
            {inFlight ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
            Run dev now
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void wizard.injectTestEvent()}>
            Skip — just inject test event
          </Button>
        </div>
      ) : (
        <div className="mt-4 text-[12.5px]" style={{ color: "var(--text)" }}>
          {runDev.injected ? (
            <span className="inline-flex items-center gap-2">
              <CheckCircle2 size={14} style={{ color: "var(--verified, #A6C2B0)" }} />
              Test event injected — waiting for cloud confirmation…
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <XCircle size={14} style={{ color: "var(--danger, #E26F6F)" }} />
              {runDev.note ?? "Test event failed"}
            </span>
          )}
        </div>
      )}
      <ProgressBar fraction={fraction} />
      <LogTail entries={log} />
      {error ? <ErrorBlock message={error} /> : null}
    </Card>
  );
}

// ── Step 5 — Verify ─────────────────────────────────────────────────────────

function VerifyStep() {
  const verified = useWizard((s) => s.verified);
  const dismiss = useWizard((s) => s.dismiss);

  return (
    <Card>
      <CardHead
        icon={verified ? (
          <CheckCircle2 size={14} strokeWidth={1.6} style={{ color: "var(--verified, #A6C2B0)" }} />
        ) : (
          <Loader2 size={14} className="animate-spin" />
        )}
        title={verified ? "Setup verified" : "Waiting for first event…"}
      >
        {verified
          ? "First event landed in the InariWatch pipeline. You're live."
          : "Once the cloud receives the first event we'll mark setup complete."}
      </CardHead>
      <div className="mt-5 flex items-center gap-3">
        <Button
          size="sm"
          variant="primary"
          disabled={!verified}
          onClick={() => void dismiss()}
        >
          <Check size={12} aria-hidden="true" /> Done
        </Button>
        <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>
          You can leave this window open — we'll mark verified automatically.
        </span>
      </div>
    </Card>
  );
}

// ── Shared building blocks ──────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="p-5"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border-strong)",
        borderRadius: 12,
      }}
    >
      {children}
    </div>
  );
}

function CardHead({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <span style={{ color: "var(--text-muted)" }}>{icon}</span>
        <h3
          className="text-[14px] font-medium tracking-[-0.005em]"
          style={{ color: "var(--text)" }}
        >
          {title}
        </h3>
      </div>
      <p
        className="text-[12.5px] mt-1.5 leading-[1.6]"
        style={{ color: "var(--text-subtle)" }}
      >
        {children}
      </p>
    </div>
  );
}

function ProgressBar({ fraction }: { fraction: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return (
    <div className="mt-5">
      <div
        style={{
          height: 4,
          borderRadius: 999,
          background: "rgba(255,255,255,0.05)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "var(--accent)",
            borderRadius: 999,
            transition: "width 200ms",
          }}
        />
      </div>
      <div
        className="mt-1.5 text-[11px]"
        style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
      >
        {pct}%
      </div>
    </div>
  );
}

function LogTail({ entries }: { entries: { stage: string; message: string; at: number }[] }) {
  if (entries.length === 0) return null;
  const tail = entries.slice(-12);
  return (
    <div
      className="mt-4 p-3 max-h-[180px] overflow-auto"
      style={{
        background: "rgba(0,0,0,0.18)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: 1.55,
        color: "var(--text-muted)",
      }}
    >
      {tail.map((e, i) => (
        <div key={`${e.at}-${i}`} className="truncate">
          <span style={{ color: "var(--text-faint)" }}>[{e.stage}]</span> {e.message}
        </div>
      ))}
    </div>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <div
      className="mt-4 p-3 text-[12px]"
      style={{
        background: "rgba(226,111,111,0.06)",
        border: "1px solid rgba(226,111,111,0.30)",
        borderRadius: 8,
        color: "var(--danger, #E26F6F)",
      }}
    >
      {message}
    </div>
  );
}

function ActionBar({ onClose, closing }: { onClose: () => void; closing: boolean }) {
  const verified = useWizard((s) => s.verified);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={onClose} disabled={closing}>
        {verified ? "Close" : "Cancel"}
      </Button>
      <span
        className="text-[11.5px]"
        style={{ color: "var(--text-faint)" }}
      >
        <Globe size={11} className="inline mr-1.5" aria-hidden="true" />
        Mirrored in <code className="font-mono">app.inariwatch.com</code>
      </span>
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the SSE URL the wizard subscribes to. The Tauri webview can't
 * read the bearer through standard EventSource (no headers API), so
 * the URL embeds the user's device bearer as a query param. The web
 * route accepts both — see `event-stream/route.ts`.
 *
 * Returns null when not connected. The wizard then relies purely on
 * the desktop-side IPC progress events for verification (test inject
 * still completes locally).
 */
async function resolveEventStreamUrl(projectId: string): Promise<string | null> {
  // Avoid coupling to the auth IPC — the URL is constructed directly
  // from the cloud bearer the desktop already loaded. We re-use the
  // same `cloud-ipc` module devices-tab uses for its API URL.
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const status = await invoke<{ connected: boolean; api_url: string; bearer?: string }>(
      "desktop_auth_status",
    );
    if (!status.connected) return null;
    const base = status.api_url.replace(/\/$/, "");
    // We can't safely surface the bearer through this status command
    // (returns connected/url only). The web route falls back to
    // session auth — which the Tauri webview doesn't have either —
    // so for V1 the SSE is best-effort. The desktop-side IPC progress
    // events still drive the wizard when SSE isn't reachable; the
    // wizard's "Done" button is enabled after the test event POST
    // returns 2xx (acked by `dev.test_event_acked` log).
    return `${base}/api/projects/${encodeURIComponent(projectId)}/event-stream`;
  } catch {
    return null;
  }
}
