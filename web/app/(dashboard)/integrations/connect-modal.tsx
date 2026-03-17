"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, useTransition } from "react";
import { X, ExternalLink, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { connectIntegration } from "./actions";

// ── Per-service config ─────────────────────────────────────────────────────────

const SERVICE_CONFIG: Record<string, {
  tokenUrl?: string;
  tokenLabel: string;
  placeholder: string;
  permissions?: { label: string; scope: string }[];
  note?: string;
  mode?: "token" | "uptime" | "postgres" | "npm";
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
};

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  service: string;
  label: string;
  projects: { id: string; name: string }[];
  children: React.ReactNode;
}

export function ConnectModal({ service, label, projects, children }: Props) {
  const [open, setOpen]    = useState(false);
  const [error, setError]  = useState("");
  const [isPending, start] = useTransition();

  const cfg = SERVICE_CONFIG[service];

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

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { setOpen(v); setError(""); }}>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />

        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#222] bg-[#0d0d0d] shadow-[0_0_60px_rgba(0,0,0,0.7)] focus:outline-none">

          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#1a1a1a] px-5 py-4">
            <Dialog.Title className="text-sm font-semibold text-white">
              Connect {label}
            </Dialog.Title>
            <Dialog.Close className="rounded-md p-1 text-zinc-600 hover:text-zinc-300 transition-colors">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {projects.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-zinc-500">Create a project first.</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="space-y-5 px-5 py-5">

                {/* Project selector */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                    Project
                  </label>
                  <select
                    name="projectId"
                    required
                    className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2 text-sm text-zinc-100 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                  >
                    <option value="">Select a project…</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>

                {cfg && cfg.mode === "postgres" ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                        Connection String
                      </label>
                      <input
                        type="password"
                        name="connection_string"
                        placeholder={cfg.placeholder}
                        required
                        autoComplete="off"
                        className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                        Display name (optional)
                      </label>
                      <input
                        type="text"
                        name="db_name"
                        placeholder="Production DB"
                        autoComplete="off"
                        className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    {cfg.note && (
                      <p className="text-[11px] text-zinc-700">{cfg.note}</p>
                    )}
                  </>
                ) : cfg && cfg.mode === "npm" ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                        package.json URL (optional)
                      </label>
                      <input
                        type="url"
                        name="package_json_url"
                        placeholder="https://raw.githubusercontent.com/owner/repo/main/package.json"
                        autoComplete="off"
                        className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                        Cargo.toml URL (optional)
                      </label>
                      <input
                        type="url"
                        name="cargo_toml_url"
                        placeholder="https://raw.githubusercontent.com/owner/repo/main/Cargo.toml"
                        autoComplete="off"
                        className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                        GitHub token (optional, for private repos)
                      </label>
                      <input
                        type="password"
                        name="token"
                        placeholder="github_pat_…"
                        autoComplete="off"
                        className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    {cfg.note && (
                      <p className="text-[11px] text-zinc-700">{cfg.note}</p>
                    )}
                  </>
                ) : cfg && cfg.mode === "uptime" ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                        Endpoint URL
                      </label>
                      <input
                        type="url"
                        name="endpoint_url"
                        placeholder={cfg.placeholder}
                        required
                        autoComplete="off"
                        className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                        Name (optional)
                      </label>
                      <input
                        type="text"
                        name="endpoint_name"
                        placeholder="Production API"
                        autoComplete="off"
                        className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                          Expected status
                        </label>
                        <input
                          type="number"
                          name="expected_status"
                          defaultValue={200}
                          min={100}
                          max={599}
                          className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 text-sm text-zinc-100 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                          Timeout (ms)
                        </label>
                        <input
                          type="number"
                          name="timeout_ms"
                          defaultValue={10000}
                          min={1000}
                          max={60000}
                          className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 text-sm text-zinc-100 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                        />
                      </div>
                    </div>
                    {cfg.note && (
                      <p className="text-[11px] text-zinc-700">{cfg.note}</p>
                    )}
                  </>
                ) : cfg ? (
                  <>
                    {/* Step 1 */}
                    <div className="space-y-2">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                        Step 1 — Get your token
                      </p>
                      {cfg.tokenUrl && (
                        <a
                          href={cfg.tokenUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-between rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 text-sm text-zinc-300 hover:border-zinc-600 hover:text-white transition-all"
                        >
                          <span>Open {label} token page</span>
                          <ExternalLink className="h-3.5 w-3.5 text-zinc-600" />
                        </a>
                      )}

                      {/* Permissions */}
                      {cfg.permissions && cfg.permissions.length > 0 && (
                        <div className="rounded-lg border border-[#1a1a1a] bg-[#080808] px-3 py-2.5 space-y-1.5">
                          <p className="text-[11px] text-zinc-700 mb-2">Select these permissions:</p>
                          {cfg.permissions.map((p) => (
                            <div key={p.label} className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Check className="h-3 w-3 text-green-600" />
                                <span className="font-mono text-[12px] text-zinc-400">{p.label}</span>
                              </div>
                              <span className="text-[11px] text-zinc-700">{p.scope}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Step 2 */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                        Step 2 — Paste your token
                      </label>
                      <input
                        type="password"
                        name="token"
                        placeholder={cfg.placeholder}
                        required
                        autoComplete="off"
                        className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                      />
                      {cfg.note && (
                        <p className="text-[11px] text-zinc-700">{cfg.note}</p>
                      )}
                    </div>
                  </>
                ) : null}

                <input type="hidden" name="service" value={service} />

                {error && (
                  <p className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-[12px] text-red-400 font-mono">
                    {error}
                  </p>
                )}
              </div>

              {/* Footer */}
              <div className="flex gap-2 border-t border-[#1a1a1a] px-5 py-4">
                <Dialog.Close asChild>
                  <Button variant="outline" className="flex-1" type="button">Cancel</Button>
                </Dialog.Close>
                <Button variant="primary" className="flex-1" type="submit" disabled={isPending}>
                  {isPending ? "Connecting…" : `Connect ${label}`}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
