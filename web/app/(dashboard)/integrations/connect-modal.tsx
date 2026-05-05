"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, useTransition } from "react";
import { X, ExternalLink, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  connectIntegration,
  lookupGitHubInstallation,
  connectGitHubInstallation,
} from "./actions";

type LookupResult = {
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
};

// ── Per-service config ─────────────────────────────────────────────────────────

interface HostingExtraField {
  name: string;
  label: string;
  placeholder: string;
  required?: boolean;
}

const SERVICE_CONFIG: Record<string, {
  tokenUrl?: string;
  tokenLabel: string;
  placeholder: string;
  permissions?: { label: string; scope: string }[];
  note?: string;
  mode?: "token" | "uptime" | "postgres" | "npm" | "datadog" | "hosting";
  extraFields?: HostingExtraField[];
}> = {
  github: {
    tokenUrl: "https://github.com/settings/personal-access-tokens/new",
    tokenLabel: "Fine-grained Personal Access Token",
    placeholder: "github_pat_…",
    permissions: [
      { label: "Contents",      scope: "Read-only" },
      { label: "Metadata",      scope: "Read-only" },
      { label: "Pull requests", scope: "Read-only" },
    ],
    note: "We'll auto-detect your username and repos.",
  },
  vercel: {
    tokenUrl: "https://vercel.com/account/tokens",
    tokenLabel: "Account Token",
    placeholder: "xxxxxxxxxxxxxxxxxxxxxxxx",
    permissions: [
      { label: "Deployments", scope: "Read" },
      { label: "Projects",    scope: "Read" },
    ],
    note: "We'll auto-detect your team and projects.",
  },
  netlify: {
    tokenUrl: "https://app.netlify.com/user/applications/personal",
    tokenLabel: "Personal Access Token",
    placeholder: "nfp_...",
    permissions: [
      { label: "Deploys",  scope: "Read/Write" },
      { label: "Sites",    scope: "Read" },
    ],
    note: "Site ID is in Site settings → General → Site information.",
    mode: "hosting",
    extraFields: [
      { name: "siteId", label: "Site ID", placeholder: "12345678-abcd-efgh-ijkl-...", required: true },
    ],
  },
  "cloudflare-pages": {
    tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
    tokenLabel: "API Token",
    placeholder: "cf_token_...",
    permissions: [
      { label: "Cloudflare Pages", scope: "Edit" },
      { label: "Account",          scope: "Read" },
    ],
    note: "Account ID is in the right sidebar of your Cloudflare dashboard.",
    mode: "hosting",
    extraFields: [
      { name: "accountId",   label: "Account ID",   placeholder: "abc123def456...", required: true },
      { name: "projectName", label: "Project Name", placeholder: "my-pages-project", required: true },
    ],
  },
  render: {
    tokenUrl: "https://dashboard.render.com/account/api-keys",
    tokenLabel: "API Key",
    placeholder: "rnd_...",
    permissions: [
      { label: "Services", scope: "Read/Write" },
    ],
    note: "Service ID is in the URL when viewing a service (srv-xxxxx).",
    mode: "hosting",
    extraFields: [
      { name: "serviceId",   label: "Service ID",        placeholder: "srv-abc123...", required: true },
      { name: "projectName", label: "Service Name (display)", placeholder: "my-api", required: true },
    ],
  },
  sentry: {
    tokenUrl: "https://sentry.io/settings/account/api/auth-tokens/",
    tokenLabel: "User Auth Token",
    placeholder: "sntrys_…",
    permissions: [
      { label: "event:read",        scope: "Required" },
      { label: "organization:read", scope: "Required" },
      { label: "project:read",      scope: "Required" },
    ],
    note: "We'll auto-detect your org and projects.",
  },
  uptime: {
    tokenLabel: "Endpoint URL",
    placeholder: "https://api.example.com/health",
    note: "Add the URL you want to monitor. You can add more endpoints later in the config.",
    mode: "uptime",
  },
  postgres: {
    tokenLabel: "Connection String",
    placeholder: "postgresql://user:pass@host:5432/dbname",
    note: "We'll connect read-only to check connection health, active connections, and long-running queries.",
    mode: "postgres",
  },
  npm: {
    tokenLabel: "Package file URL",
    placeholder: "https://raw.githubusercontent.com/owner/repo/main/package.json",
    note: "Paste a raw GitHub URL to your package.json or Cargo.toml. We'll scan dependencies for known CVEs via the GitHub Advisory Database.",
    mode: "npm",
  },
  datadog: {
    tokenUrl: "https://app.datadoghq.com/organization-settings/api-keys",
    tokenLabel: "API Key",
    placeholder: "your_datadog_api_key",
    permissions: [
      { label: "monitors_read", scope: "Required" },
      { label: "events_read",   scope: "Required" },
    ],
    note: "We'll validate your keys and generate a Webhook URL for you to configure in Datadog → Integrations → Webhooks.",
    mode: "datadog",
  },
  expo: {
    tokenUrl: "https://expo.dev/settings/access-tokens",
    tokenLabel: "Personal Access Token",
    placeholder: "expo_...",
    permissions: [
      { label: "Projects", scope: "Read" },
      { label: "Builds",   scope: "Read" },
    ],
    note: "We'll auto-detect your Expo username and projects.",
  },
  capture: {
    tokenLabel: "",
    placeholder: "",
    note: "No token needed. We'll generate a DSN for your app. Install with: npx @inariwatch/mcp init",
    mode: "capture" as never,
  },
  agent: {
    tokenLabel: "",
    placeholder: "",
    note: "No token needed. We'll generate credentials for the InariWatch Agent. Install with: curl -sf https://install.inariwatch.com | sh",
    mode: "agent" as never,
  },
};

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  service: string;
  label: string;
  projects: { id: string; name: string }[];
  children: React.ReactNode;
  /**
   * When set, the github card switches from PAT-paste UX to a one-click
   * "Install GitHub App" redirect. Threaded down from the server component
   * (page.tsx reads it from env and passes the slug, NOT a NEXT_PUBLIC_*
   * which would expose it on every page in the app). Empty / undefined →
   * falls back to the PAT path.
   */
  githubAppSlug?: string;
}

export function ConnectModal({ service, label, projects, children, githubAppSlug }: Props) {
  const [open, setOpen]            = useState(false);
  const [error, setError]          = useState("");
  const [projectId, setProjectId]  = useState("");
  const [isPending, start]         = useTransition();

  // Existing-installation lookup state. `lookupLogin` is the typed input,
  // `lookup` is the resolved installation (set after a successful query),
  // `lookupBusy` while the server action is in flight.
  const [lookupLogin, setLookupLogin] = useState("");
  const [lookup, setLookup]           = useState<LookupResult | null>(null);
  const [lookupBusy, setLookupBusy]   = useState(false);

  const cfg = SERVICE_CONFIG[service];
  const useGitHubApp = service === "github" && !!githubAppSlug;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const formData = new FormData(e.currentTarget);
    start(async () => {
      const result = await connectIntegration(formData);
      if (result.error) setError(result.error);
      else setOpen(false);
    });
  };

  const handleInstallApp = () => {
    setError("");
    if (!projectId) { setError("Select a project first."); return; }
    // GitHub forwards `state` to the App's redirect URL — we round-trip
    // the projectId so /api/integrations/github-app/setup can attach the
    // installation to the correct project_integrations row.
    const url = `https://github.com/apps/${encodeURIComponent(githubAppSlug ?? "")}/installations/new?state=${encodeURIComponent(projectId)}`;
    window.location.href = url;
  };

  const handleLookup = async () => {
    setError("");
    setLookup(null);
    if (!lookupLogin.trim()) {
      setError("Enter your GitHub username or org name.");
      return;
    }
    setLookupBusy(true);
    try {
      const result = await lookupGitHubInstallation(lookupLogin.trim());
      if (result.error || !result.installation) {
        setError(result.error ?? "Not found.");
        return;
      }
      setLookup(result.installation);
    } finally {
      setLookupBusy(false);
    }
  };

  const handleConnectExisting = () => {
    setError("");
    if (!projectId) { setError("Select a project first."); return; }
    if (!lookup) return;
    start(async () => {
      const result = await connectGitHubInstallation(
        projectId,
        lookup.installationId,
        lookup.accountLogin,
      );
      if (result.error) setError(result.error);
      else setOpen(false);
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { setOpen(v); setError(""); }}>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />

        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line-medium bg-surface-dim shadow-[0_0_60px_rgba(0,0,0,0.7)] focus:outline-none">

          {/* Header */}
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <Dialog.Title className="text-sm font-semibold text-fg-strong">
              Connect {label}
            </Dialog.Title>
            <Dialog.Close className="rounded-md p-1 text-fg-base/50 hover:text-fg-base transition-colors">
              <X aria-hidden="true" className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {projects.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-fg-base/60">Create a project first.</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="space-y-5 px-5 py-5">

                {/* Project selector */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                    Project
                  </label>
                  <select
                    name="projectId"
                    required
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                  >
                    <option value="">Select a project…</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>

                {useGitHubApp ? (
                  <div className="space-y-3">
                    {/* Existing installation lookup — primary path for users who
                        already installed InariWatch on github.com previously. */}
                    <div className="rounded-lg border border-line bg-surface-inner px-3 py-3 space-y-2">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Already installed?
                      </p>
                      {lookup ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between rounded-md border border-green-500/30 bg-green-500/5 px-2.5 py-2">
                            <div className="text-xs text-fg-base/70">
                              <span className="font-mono text-fg-strong">{lookup.accountLogin}</span>{" "}
                              <span className="text-fg-base/40">
                                · {lookup.accountType.toLowerCase()} ·{" "}
                                {lookup.repositorySelection === "all" ? "all repos" : "selected repos"}
                              </span>
                            </div>
                            <Check className="h-3.5 w-3.5 text-green-600" />
                          </div>
                          <button
                            type="button"
                            onClick={() => { setLookup(null); setLookupLogin(""); }}
                            className="text-[11px] text-fg-base/40 underline-offset-2 hover:underline"
                          >
                            Use a different account
                          </button>
                        </div>
                      ) : (
                        // NOT a nested <form> — HTML disallows that and browsers
                        // bubble the inner submit up to the outer form, which would
                        // close the modal. Plain div + Enter-key handler on the input.
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={lookupLogin}
                            onChange={(e) => setLookupLogin(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                if (!lookupBusy) handleLookup();
                              }
                            }}
                            placeholder="GitHub username or org"
                            autoComplete="off"
                            className="min-w-0 flex-1 rounded-md border border-line-medium bg-surface-dim px-2.5 py-1.5 font-mono text-[12px] text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                          />
                          <button
                            type="button"
                            onClick={handleLookup}
                            disabled={lookupBusy}
                            className="rounded-md border border-line-medium bg-surface-dim px-3 py-1.5 text-[12px] text-fg-base hover:border-fg-base/30 disabled:opacity-50"
                          >
                            {lookupBusy ? "…" : "Find"}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Fallback / first-time install — same redirect as before. */}
                    <div className="rounded-lg border border-dashed border-line bg-surface-inner px-3 py-3 space-y-2">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        First time?
                      </p>
                      <p className="text-xs text-fg-base/60 leading-relaxed">
                        We&apos;ll redirect you to GitHub to install the InariWatch App.
                        Permissions scoped per-repo and revocable from your GitHub settings.
                      </p>
                      <ul className="space-y-1 pt-1 text-[11px] text-fg-base/50">
                        <li className="flex items-center gap-1.5">
                          <Check className="h-3 w-3 text-green-600" />
                          <span>Contents (read), Pull requests (read/write), Checks (read)</span>
                        </li>
                        <li className="flex items-center gap-1.5">
                          <Check className="h-3 w-3 text-green-600" />
                          <span>No long-lived token to expire or rotate</span>
                        </li>
                      </ul>
                    </div>
                  </div>
                ) : cfg && (cfg.mode as string) === "capture" ? (
                  <div className="rounded-lg border border-line bg-surface-inner px-3 py-2.5">
                    <p className="text-xs text-fg-base/60 leading-relaxed">
                      No token needed. Click Connect and we&apos;ll generate a DSN for your app.
                    </p>
                    <p className="mt-2 text-xs text-fg-base/50">
                      Then add it to your <code className="text-fg-base/60">.env</code>:
                    </p>
                    <pre className="mt-1 text-[11px] text-fg-base/60 font-mono">INARIWATCH_DSN=https://...</pre>
                  </div>
                ) : cfg && (cfg.mode as string) === "agent" ? (
                  <div className="rounded-lg border border-line bg-surface-inner px-3 py-2.5">
                    <p className="text-xs text-fg-base/60 leading-relaxed">
                      No token needed. Click Connect and we&apos;ll generate credentials for the InariWatch Agent.
                    </p>
                    <p className="mt-2 text-xs text-fg-base/50">
                      Install on your server:
                    </p>
                    <pre className="mt-1 text-[11px] text-fg-base/60 font-mono">curl -sf https://install.inariwatch.com | sh</pre>
                  </div>
                ) : cfg && cfg.mode === "postgres" ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Connection String
                      </label>
                      <input
                        type="password"
                        name="connection_string"
                        placeholder={cfg.placeholder}
                        required
                        autoComplete="off"
                        className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 font-mono text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Display name (optional)
                      </label>
                      <input
                        type="text"
                        name="db_name"
                        placeholder="Production DB"
                        autoComplete="off"
                        className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    {cfg.note && (
                      <p className="text-[11px] text-fg-base/40">{cfg.note}</p>
                    )}
                  </>
                ) : cfg && cfg.mode === "npm" ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        package.json URL (optional)
                      </label>
                      <input
                        type="url"
                        name="package_json_url"
                        placeholder="https://raw.githubusercontent.com/owner/repo/main/package.json"
                        autoComplete="off"
                        className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 font-mono text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Cargo.toml URL (optional)
                      </label>
                      <input
                        type="url"
                        name="cargo_toml_url"
                        placeholder="https://raw.githubusercontent.com/owner/repo/main/Cargo.toml"
                        autoComplete="off"
                        className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 font-mono text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        GitHub token (optional, for private repos)
                      </label>
                      <input
                        type="password"
                        name="token"
                        placeholder="github_pat_…"
                        autoComplete="off"
                        className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 font-mono text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    {cfg.note && (
                      <p className="text-[11px] text-fg-base/40">{cfg.note}</p>
                    )}
                  </>
                ) : cfg && cfg.mode === "uptime" ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Endpoint URL
                      </label>
                      <input
                        type="url"
                        name="endpoint_url"
                        placeholder={cfg.placeholder}
                        required
                        autoComplete="off"
                        className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 font-mono text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Name (optional)
                      </label>
                      <input
                        type="text"
                        name="endpoint_name"
                        placeholder="Production API"
                        autoComplete="off"
                        className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                          Expected status
                        </label>
                        <input
                          type="number"
                          name="expected_status"
                          defaultValue={200}
                          min={100}
                          max={599}
                          className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                          Timeout (ms)
                        </label>
                        <input
                          type="number"
                          name="timeout_ms"
                          defaultValue={10000}
                          min={1000}
                          max={60000}
                          className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                        />
                      </div>
                    </div>
                    {cfg.note && (
                      <p className="text-[11px] text-fg-base/40">{cfg.note}</p>
                    )}
                  </>
                ) : cfg && cfg.mode === "hosting" ? (
                  <>
                    {/* Step 1 — Open token page */}
                    <div className="space-y-2">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Step 1 — Get your token
                      </p>
                      {cfg.tokenUrl && (
                        <a
                          href={cfg.tokenUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-between rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 text-sm text-fg-base hover:border-fg-base/30 hover:text-fg-strong transition-all"
                        >
                          <span>Open {label} token page</span>
                          <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 text-fg-base/40" />
                        </a>
                      )}
                      {cfg.permissions && cfg.permissions.length > 0 && (
                        <div className="rounded-lg border border-line bg-surface-inner px-3 py-2.5 space-y-1.5">
                          <p className="text-[11px] text-fg-base/40 mb-2">Select these permissions:</p>
                          {cfg.permissions.map((p) => (
                            <div key={p.label} className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Check className="h-3 w-3 text-green-600" />
                                <span className="font-mono text-[12px] text-fg-base/60">{p.label}</span>
                              </div>
                              <span className="text-[11px] text-fg-base/40">{p.scope}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Step 2 — Paste token */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Step 2 — {cfg.tokenLabel}
                      </label>
                      <input
                        type="password"
                        name="token"
                        placeholder={cfg.placeholder}
                        required
                        autoComplete="off"
                        className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 font-mono text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>

                    {/* Step 3..N — Extra identifier fields per provider */}
                    {cfg.extraFields?.map((field, i) => (
                      <div key={field.name} className="space-y-1.5">
                        <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                          Step {3 + i} — {field.label}
                        </label>
                        <input
                          type="text"
                          name={field.name}
                          placeholder={field.placeholder}
                          required={field.required}
                          autoComplete="off"
                          className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 font-mono text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                        />
                      </div>
                    ))}

                    {cfg.note && (
                      <p className="text-[11px] text-fg-base/40">{cfg.note}</p>
                    )}
                  </>
                ) : cfg && cfg.mode === "datadog" ? (
                  <>
                    {/* Step 1 — Open keys page */}
                    <div className="space-y-2">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Step 1 — Get your keys
                      </p>
                      {cfg.tokenUrl && (
                        <a
                          href={cfg.tokenUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-between rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 text-sm text-fg-base hover:border-fg-base/30 hover:text-fg-strong transition-all"
                        >
                          <span>Open Datadog API Keys page</span>
                          <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 text-fg-base/40" />
                        </a>
                      )}
                      {cfg.permissions && cfg.permissions.length > 0 && (
                        <div className="rounded-lg border border-line bg-surface-inner px-3 py-2.5 space-y-1.5">
                          <p className="text-[11px] text-fg-base/40 mb-2">Recommended scopes:</p>
                          {cfg.permissions.map((p) => (
                            <div key={p.label} className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Check className="h-3 w-3 text-green-600" />
                                <span className="font-mono text-[12px] text-fg-base/60">{p.label}</span>
                              </div>
                              <span className="text-[11px] text-fg-base/40">{p.scope}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Step 2 — API Key */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Step 2 — API Key
                      </label>
                      <input
                        type="password"
                        name="token"
                        placeholder="your_datadog_api_key"
                        required
                        autoComplete="off"
                        className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 font-mono text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>

                    {/* Step 3 — Application Key */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Step 3 — Application Key
                      </label>
                      <input
                        type="password"
                        name="app_key"
                        placeholder="your_datadog_application_key"
                        required
                        autoComplete="off"
                        className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 font-mono text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>

                    {cfg.note && (
                      <p className="text-[11px] text-fg-base/40">{cfg.note}</p>
                    )}
                  </>
                ) : cfg ? (
                  <>
                    {/* Step 1 */}
                    <div className="space-y-2">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Step 1 — Get your token
                      </p>
                      {cfg.tokenUrl && (
                        <a
                          href={cfg.tokenUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-between rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 text-sm text-fg-base hover:border-fg-base/30 hover:text-fg-strong transition-all"
                        >
                          <span>Open {label} token page</span>
                          <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 text-fg-base/40" />
                        </a>
                      )}

                      {/* Permissions */}
                      {cfg.permissions && cfg.permissions.length > 0 && (
                        <div className="rounded-lg border border-line bg-surface-inner px-3 py-2.5 space-y-1.5">
                          <p className="text-[11px] text-fg-base/40 mb-2">Select these permissions:</p>
                          {cfg.permissions.map((p) => (
                            <div key={p.label} className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Check className="h-3 w-3 text-green-600" />
                                <span className="font-mono text-[12px] text-fg-base/60">{p.label}</span>
                              </div>
                              <span className="text-[11px] text-fg-base/40">{p.scope}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Step 2 */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-fg-base/50">
                        Step 2 — Paste your token
                      </label>
                      <input
                        type="password"
                        name="token"
                        placeholder={cfg.placeholder}
                        required
                        autoComplete="off"
                        className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2.5 font-mono text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                      {cfg.note && (
                        <p className="text-[11px] text-fg-base/40">{cfg.note}</p>
                      )}
                    </div>
                  </>
                ) : null}

                <input type="hidden" name="service" value={service} />

                {error && (
                  <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[12px] text-red-600 dark:text-red-400 font-mono">
                    {error}
                  </p>
                )}
              </div>

              {/* Footer */}
              <div className="flex gap-2 border-t border-line px-5 py-4">
                <Dialog.Close asChild>
                  <Button variant="outline" className="flex-1" type="button">Cancel</Button>
                </Dialog.Close>
                {useGitHubApp ? (
                  lookup ? (
                    <Button
                      variant="primary"
                      className="flex-1"
                      type="button"
                      onClick={handleConnectExisting}
                      disabled={isPending}
                    >
                      {isPending ? "Connecting…" : `Connect ${lookup.accountLogin}`}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      className="flex-1"
                      type="button"
                      onClick={handleInstallApp}
                    >
                      Install GitHub App
                    </Button>
                  )
                ) : (
                  <Button variant="primary" className="flex-1" type="submit" disabled={isPending}>
                    {isPending ? "Connecting…" : `Connect ${label}`}
                  </Button>
                )}
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
