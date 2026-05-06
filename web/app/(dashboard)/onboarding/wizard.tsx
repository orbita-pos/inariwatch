"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import {
  FolderPlus,
  Github,
  Zap,
  AlertTriangle,
  Check,
  ArrowRight,
  Bell,
  Sparkles,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { connectIntegration } from "../integrations/actions";

// ── Step indicator ────────────────────────────────────────────────────────────

function StepIndicator({ currentStep, totalSteps }: { currentStep: number; totalSteps: number }) {
  const steps = [
    { num: 1, label: "Project" },
    { num: 2, label: "Integrations" },
    { num: 3, label: "Notifications" },
    { num: 4, label: "Done" },
  ];

  return (
    <div className="flex items-center justify-center gap-0">
      {steps.slice(0, totalSteps).map((step, idx) => {
        const isActive = step.num === currentStep;
        const isCompleted = step.num < currentStep;

        return (
          <div key={step.num} className="flex items-center">
            {/* Step circle */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-bold transition-all duration-300 ${
                  isCompleted
                    ? "border-inari-accent bg-inari-accent text-white"
                    : isActive
                    ? "border-inari-accent bg-inari-accent/10 text-inari-accent"
                    : "border-line-medium bg-transparent text-fg-base/50"
                }`}
              >
                {isCompleted ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : step.num}
              </div>
              <span
                className={`text-[11px] font-medium transition-colors duration-300 ${
                  isActive ? "text-fg-strong" : isCompleted ? "text-fg-base/60" : "text-fg-base/40"
                }`}
              >
                {step.label}
              </span>
            </div>

            {/* Connector line */}
            {idx < totalSteps - 1 && (
              <div className="mx-1.5 sm:mx-3 mb-5 h-[2px] w-8 sm:w-12">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    isCompleted ? "bg-inari-accent" : "bg-line-medium"
                  }`}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ currentStep, totalSteps }: { currentStep: number; totalSteps: number }) {
  const progress = ((currentStep - 1) / (totalSteps - 1)) * 100;

  return (
    <div className="h-1 w-full rounded-full bg-line overflow-hidden">
      <div
        className="h-full rounded-full bg-inari-accent transition-all duration-500 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}

// ── Step wrapper (animated) ───────────────────────────────────────────────────

function StepContainer({
  children,
  active,
}: {
  children: React.ReactNode;
  active: boolean;
}) {
  return (
    <div
      className={`transition-all duration-400 ease-out ${
        active
          ? "opacity-100 translate-y-0"
          : "opacity-0 translate-y-4 pointer-events-none absolute inset-0"
      }`}
    >
      {children}
    </div>
  );
}

// ── Service config for integration cards ──────────────────────────────────────

const SERVICES = [
  {
    service: "github",
    label: "GitHub",
    desc: "Monitor CI failures, stale PRs, and unreviewed pull requests",
    icon: Github,
    placeholder: "github_pat_...",
    tokenUrl: "https://github.com/settings/personal-access-tokens/new",
    tokenLabel: "Fine-grained Personal Access Token",
  },
  {
    service: "vercel",
    label: "Vercel",
    desc: "Track failed deployments and build errors",
    icon: Zap,
    placeholder: "xxxxxxxxxxxxxxxxxxxxxxxx",
    tokenUrl: "https://vercel.com/account/tokens",
    tokenLabel: "Account Token",
  },
  {
    service: "sentry",
    label: "Sentry",
    desc: "Catch new errors and regressions in real-time",
    icon: AlertTriangle,
    placeholder: "sntrys_...",
    tokenUrl: "https://sentry.io/settings/account/api/auth-tokens/",
    tokenLabel: "User Auth Token",
  },
] as const;

// ── Integration card ──────────────────────────────────────────────────────────

function IntegrationCard({
  service,
  projectId,
  connected,
  onConnected,
}: {
  service: (typeof SERVICES)[number];
  projectId: string;
  connected: boolean;
  onConnected: (svc: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();
  const Icon = service.icon;

  const handleConnect = () => {
    if (!token.trim()) {
      setError("Please enter a token.");
      return;
    }
    setError("");
    const formData = new FormData();
    formData.set("projectId", projectId);
    formData.set("service", service.service);
    formData.set("token", token.trim());

    startTransition(async () => {
      const result = await connectIntegration(formData);
      if (result.error) {
        setError(result.error);
      } else {
        onConnected(service.service);
        setExpanded(false);
        setToken("");
      }
    });
  };

  if (connected) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-green-500/20 bg-green-500/[0.04] p-4 transition-all">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-green-500/20 bg-green-500/10 shrink-0">
          <Check className="h-5 w-5 text-green-500" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg-base">{service.label}</p>
          <p className="text-xs text-green-500/70">Connected</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface transition-all">
      {/* Header (clickable to expand) */}
      <button
        type="button"
        onClick={() => { setExpanded(!expanded); setError(""); }}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface-dim text-fg-base/50 shrink-0">
          <Icon aria-hidden="true" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg-base">{service.label}</p>
          <p className="text-xs text-fg-base/60">{service.desc}</p>
        </div>
        <ArrowRight
          aria-hidden="true"
          className={`h-4 w-4 text-fg-base/40 transition-transform duration-200 ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>

      {/* Expanded token input */}
      {expanded && (
        <div className="border-t border-line px-4 pb-4 pt-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
              {service.tokenLabel}
            </label>
            <a
              href={service.tokenUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-[11px] text-inari-accent hover:text-inari-accent/80 transition-colors"
            >
              Get token <ExternalLink aria-hidden="true" className="h-3 w-3" />
            </a>
          </div>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={service.placeholder}
            autoComplete="off"
            className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 font-mono text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
          />

          {error && (
            <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[12px] text-red-600 dark:text-red-400 font-mono">
              {error}
            </p>
          )}

          <Button
            variant="primary"
            size="sm"
            className="w-full"
            onClick={handleConnect}
            disabled={isPending}
          >
            {isPending ? (
              <>
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Connecting...
              </>
            ) : (
              `Connect ${service.label}`
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Celebration particles ─────────────────────────────────────────────────────

function Celebration() {
  // Pre-compute particle properties to keep them stable across the render
  const particles = Array.from({ length: 24 }).map((_, i) => ({
    left: (i * 4.17 + (i % 3) * 12.5) % 100,
    delay: (i * 0.05) % 1.2,
    duration: 2 + (i % 5) * 0.3,
    size: 4 + (i % 4) * 1.5,
    rotation: 360 + (i * 47) % 360,
  }));

  const colors = [
    "bg-inari-accent",
    "bg-purple-400",
    "bg-indigo-400",
    "bg-violet-300",
    "bg-fuchsia-400",
    "bg-pink-400",
  ];

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {particles.map((p, i) => (
        <div
          key={i}
          className={`absolute rounded-full ${colors[i % colors.length]}`}
          style={{
            left: `${p.left}%`,
            top: "-10px",
            width: `${p.size}px`,
            height: `${p.size}px`,
            opacity: 0,
            animation: `confetti-fall-${i} ${p.duration}s ${p.delay}s ease-out forwards`,
          }}
        />
      ))}

      <style>{particles.map((p, i) => `
        @keyframes confetti-fall-${i} {
          0% { opacity: 1; transform: translateY(0) rotate(0deg) scale(1); }
          100% { opacity: 0; transform: translateY(500px) rotate(${p.rotation}deg) scale(0.3); }
        }
      `).join("")}</style>
    </div>
  );
}

// ── Main wizard component ─────────────────────────────────────────────────────

export function OnboardingWizard({
  userName,
  githubAppSlug,
}: {
  userName: string;
  githubAppSlug?: string;
}) {
  const router = useRouter();
  const TOTAL_STEPS = 4;
  const canImportFromGithub = !!githubAppSlug;

  const [currentStep, setCurrentStep] = useState(1);
  const [projectId, _setProjectId] = useState<string | null>(null);
  const [connectedServices, setConnectedServices] = useState<Set<string>>(new Set());
  const [projectError] = useState("");

  const handleServiceConnected = (svc: string) => {
    setConnectedServices((prev) => new Set(prev).add(svc));
  };

  const goToDashboard = () => {
    router.push("/dashboard");
  };

  return (
    <div className="flex min-h-[calc(100vh-64px)] flex-col items-center justify-center px-4">
      <div className="w-full max-w-[540px]">
        {/* Progress bar */}
        <div className="mb-8">
          <ProgressBar currentStep={currentStep} totalSteps={TOTAL_STEPS} />
        </div>

        {/* Step indicator */}
        <div className="mb-10">
          <StepIndicator currentStep={currentStep} totalSteps={TOTAL_STEPS} />
        </div>

        {/* Step content */}
        <div className="relative min-h-[320px] sm:min-h-[360px]">
          {/* ── Step 1: Create Project ──────────────────────────────────────── */}
          <StepContainer active={currentStep === 1}>
            <div className="flex flex-col items-center text-center">
              <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-inari-accent/20 bg-inari-accent/[0.06]">
                <FolderPlus aria-hidden="true" className="h-7 w-7 text-inari-accent" />
              </div>

              <h2 className="text-xl font-semibold text-fg-strong mb-2">
                Welcome, {userName}
              </h2>
              <p className="text-sm text-fg-base/60 mb-8 max-w-sm">
                Import your repos from GitHub — we&apos;ll create one project per
                repo and open a setup PR. Without GitHub a project has nothing
                to monitor, so the manual "blank project" path is gone.
              </p>

              {canImportFromGithub ? (
                <div className="w-full max-w-sm space-y-2">
                  <Button
                    variant="primary"
                    size="lg"
                    className="w-full"
                    onClick={() => {
                      // signIn() POSTs with the CSRF token NextAuth requires
                      // to start the OAuth handshake. window.location to the
                      // signin GET URL renders an intermediate page that
                      // never actually triggered the redirect — exactly the
                      // "le doy a importar y no pasa nada" bug.
                      void signIn("github", { callbackUrl: "/dashboard?github=imported" });
                    }}
                  >
                    <Github aria-hidden="true" className="h-4 w-4" /> Import from GitHub
                    <ArrowRight aria-hidden="true" className="h-4 w-4" />
                  </Button>
                  <p className="text-[11px] text-fg-base/40">
                    One click — pick the repos you want monitored on github.com.
                  </p>
                </div>
              ) : (
                <div className="w-full max-w-sm rounded-lg border border-amber-500/30 bg-amber-500/[0.04] px-4 py-3 text-left">
                  <p className="text-[13px] text-fg-base/70">
                    GitHub App isn&apos;t configured on this server. Set
                    <code className="mx-1 rounded bg-surface-dim px-1.5 py-0.5 font-mono text-[11px]">GITHUB_APP_SLUG</code>
                    + the App credentials in env to enable repo import.
                  </p>
                </div>
              )}
              {/* Make the unused projectError binding visible only when set —
                  prevents "declared but never used" lint after dropping the
                  blank-project form. Ref: createProjectForOnboarding action
                  is kept on disk in case we ever bring back manual creation. */}
              {projectError && (
                <p className="mt-3 text-xs text-red-600 dark:text-red-400 font-mono">{projectError}</p>
              )}
            </div>
          </StepContainer>

          {/* ── Step 2: Connect Integrations ────────────────────────────────── */}
          <StepContainer active={currentStep === 2}>
            <div className="flex flex-col items-center text-center">
              <h2 className="text-xl font-semibold text-fg-strong mb-2">
                Connect your services
              </h2>
              <p className="text-sm text-fg-base/60 mb-6 max-w-sm">
                InariWatch polls these services every 1 minute and surfaces alerts
                when something needs attention.
              </p>

              <div className="w-full space-y-3 mb-6">
                {SERVICES.map((svc) => (
                  <IntegrationCard
                    key={svc.service}
                    service={svc}
                    projectId={projectId ?? ""}
                    connected={connectedServices.has(svc.service)}
                    onConnected={handleServiceConnected}
                  />
                ))}
              </div>

              {connectedServices.size > 0 && (
                <p className="text-xs text-fg-base/60 mb-4">
                  {connectedServices.size} of {SERVICES.length} connected
                </p>
              )}

              <div className="flex w-full gap-3">
                {connectedServices.size === 0 ? (
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => setCurrentStep(3)}
                  >
                    Skip for now <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => setCurrentStep(3)}
                  >
                    Continue <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </StepContainer>

          {/* ── Step 3: Notifications ───────────────────────────────────────── */}
          <StepContainer active={currentStep === 3}>
            <div className="flex flex-col items-center text-center">
              <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-inari-accent/20 bg-inari-accent/[0.06]">
                <Bell aria-hidden="true" className="h-7 w-7 text-inari-accent" />
              </div>

              <h2 className="text-xl font-semibold text-fg-strong mb-2">
                Stay in the loop
              </h2>
              <p className="text-sm text-fg-base/60 mb-8 max-w-sm">
                Get alerted on Telegram or email when something breaks.
                You can configure notification channels anytime from Settings.
              </p>

              <div className="w-full max-w-sm space-y-3 mb-8">
                {/* Telegram card */}
                <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface-dim text-fg-base/50 shrink-0">
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.99 1.27-5.62 3.72-.53.36-1.01.54-1.44.53-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.37-.49 1.02-.75 3.99-1.73 6.65-2.87 7.97-3.44 3.8-1.58 4.59-1.86 5.1-1.87.11 0 .37.03.53.17.14.12.18.28.2.45-.01.06.01.24 0 .38z" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1 text-left">
                    <p className="text-sm font-medium text-fg-base">Telegram</p>
                    <p className="text-xs text-fg-base/60">Instant alerts via bot message</p>
                  </div>
                </div>

                {/* Email card */}
                <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface-dim text-fg-base/50 shrink-0">
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                      <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1 text-left">
                    <p className="text-sm font-medium text-fg-base">Email</p>
                    <p className="text-xs text-fg-base/60">Alert digests to your inbox</p>
                  </div>
                </div>
              </div>

              <div className="flex w-full max-w-sm flex-col gap-2 sm:flex-row sm:gap-3">
                <Button
                  variant="primary"
                  className="flex-1"
                  onClick={() => {
                    router.push("/settings");
                  }}
                >
                  Go to Settings <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setCurrentStep(4)}
                >
                  Set up later
                </Button>
              </div>
            </div>
          </StepContainer>

          {/* ── Step 4: Done ────────────────────────────────────────────────── */}
          <StepContainer active={currentStep === 4}>
            <div className="relative flex flex-col items-center text-center">
              <Celebration />

              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-inari-accent/30 bg-inari-accent/10">
                <Sparkles aria-hidden="true" className="h-8 w-8 text-inari-accent" />
              </div>

              <h2 className="text-2xl font-semibold text-fg-strong mb-2">
                You&apos;re all set!
              </h2>
              <p className="text-sm text-fg-base/60 mb-2 max-w-sm">
                Your project is ready. InariWatch will start monitoring your connected
                services and surface alerts when something needs your attention.
              </p>

              {connectedServices.size > 0 && (
                <div className="flex items-center gap-2 mb-6">
                  {Array.from(connectedServices).map((svc) => {
                    const info = SERVICES.find((s) => s.service === svc);
                    return (
                      <span
                        key={svc}
                        className="inline-flex items-center gap-1.5 rounded-full border border-green-500/20 bg-green-500/[0.06] px-3 py-1 text-xs font-medium text-green-400"
                      >
                        <Check aria-hidden="true" className="h-3 w-3" />
                        {info?.label ?? svc}
                      </span>
                    );
                  })}
                </div>
              )}

              {connectedServices.size === 0 && (
                <p className="text-xs text-fg-base/50 mb-6">
                  You can connect integrations later from the Integrations page.
                </p>
              )}

              <Button
                variant="primary"
                size="lg"
                className="w-full max-w-xs"
                onClick={goToDashboard}
              >
                Go to Dashboard <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          </StepContainer>
        </div>

        {/* Step counter */}
        <div className="mt-8 text-center">
          <span className="text-xs text-fg-base/40">
            Step {currentStep} of {TOTAL_STEPS}
          </span>
        </div>
      </div>
    </div>
  );
}
