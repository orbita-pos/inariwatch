import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectIntegrations } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { formatRelativeTime } from "@/lib/utils";
import {
  CheckCircle2, XCircle, Clock, Plus,
  Github, Zap, AlertTriangle, GitBranch, Database, Package,
  Terminal, Settings2, Unplug, Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConnectModal }       from "./connect-modal";
import { CreateProjectModal } from "./create-project-modal";
import { ConfigModal }        from "./config-modal";
import { disconnectIntegration } from "./actions";
import { WebhookInfo } from "./webhook-info";
import { decryptConfig } from "@/lib/crypto";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Integrations" };

// ── Integration catalog ────────────────────────────────────────────────────────

const CATALOG = [
  {
    service:   "github",
    label:     "GitHub",
    desc:      "Stale PRs, failed CI runs, unreviewed pull requests",
    icon:      Github,
    mode:      "web" as const,
  },
  {
    service:   "vercel",
    label:     "Vercel",
    desc:      "Failed deployments, build errors, preview failures",
    icon:      Zap,
    mode:      "web" as const,
  },
  {
    service:   "sentry",
    label:     "Sentry",
    desc:      "New errors, frequency spikes, affected users",
    icon:      AlertTriangle,
    mode:      "web" as const,
  },
  {
    service:   "uptime",
    label:     "Uptime Monitor",
    desc:      "HTTP endpoint health checks, response time monitoring",
    icon:      Globe,
    mode:      "web" as const,
  },
  {
    service:   "git",
    label:     "Git local",
    desc:      "Unpushed commits, stale branches — runs on your machine",
    icon:      GitBranch,
    mode:      "cli" as const,
    cmd:       "inari add git",
  },
  {
    service:   "postgres",
    label:     "PostgreSQL",
    desc:      "Slow queries, connection spikes, table growth",
    icon:      Database,
    mode:      "web" as const,
  },
  {
    service:   "npm",
    label:     "npm / Cargo",
    desc:      "CVE alerts on your dependencies",
    icon:      Package,
    mode:      "web" as const,
  },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function IntegrationsPage() {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;

  const userProjects = userId
    ? await db.select().from(projects).where(eq(projects.userId, userId))
    : [];

  const allIntegrations =
    userProjects.length > 0
      ? await Promise.all(
          userProjects.map((p) =>
            db
              .select()
              .from(projectIntegrations)
              .where(eq(projectIntegrations.projectId, p.id))
              .then((rows) => rows.map((r) => ({ ...r, projectName: p.name })))
          )
        ).then((nested) => nested.flat())
      : [];

  // Shape projects for the modal selector
  const projectOptions = userProjects.map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="space-y-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Integrations</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Connect your services. InariWatch polls them every 5 minutes and surfaces alerts automatically.
          </p>
        </div>
        <CreateProjectModal>
          <Button variant="primary" size="sm" className="gap-1.5 shrink-0">
            <Plus className="h-3.5 w-3.5" /> New project
          </Button>
        </CreateProjectModal>
      </div>

      {/* No projects banner */}
      {userProjects.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[#1a1a1a] py-16 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#1a1a1a] bg-[#111]">
            <span className="text-base text-zinc-600">◉</span>
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-400">No projects yet</p>
            <p className="mt-1 text-sm text-zinc-600">
              Create a project to start connecting integrations.
            </p>
          </div>
          <CreateProjectModal>
            <Button variant="primary" size="sm" className="gap-1.5 mt-1">
              <Plus className="h-3.5 w-3.5" /> Create first project
            </Button>
          </CreateProjectModal>
        </div>
      )}

      {/* Integration cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CATALOG.map((item) => {
          const connected = allIntegrations.filter((i) => i.service === item.service);

          if (item.mode === "cli") {
            return <CliCard key={item.service} item={item} connected={connected} />;
          }

          // web mode
          return (
            <WebCard
              key={item.service}
              item={item}
              connected={connected}
              projectOptions={projectOptions}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Card variants ─────────────────────────────────────────────────────────────

type ConnectedRow = {
  id: string;
  service: string;
  isActive: boolean;
  lastCheckedAt: Date | null;
  errorCount: number;
  projectName: string;
  configEncrypted: unknown;
  webhookSecret: string | null;
};

function CardShell({
  item,
  children,
  highlight = false,
}: {
  item: { label: string; desc: string; icon: React.ElementType };
  children: React.ReactNode;
  highlight?: boolean;
}) {
  const Icon = item.icon;
  return (
    <div
      className={`flex flex-col rounded-xl border bg-inari-card p-5 transition-all ${
        highlight
          ? "border-inari-accent/20"
          : "border-inari-border"
      }`}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-inari-border bg-zinc-900 text-zinc-300 shrink-0">
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <span className="font-semibold text-sm text-zinc-200">{item.label}</span>
      </div>
      <p className="text-sm text-zinc-500 leading-relaxed mb-4">{item.desc}</p>
      {children}
    </div>
  );
}

function WebCard({
  item,
  connected,
  projectOptions,
}: {
  item: (typeof CATALOG)[number];
  connected: ConnectedRow[];
  projectOptions: { id: string; name: string }[];
}) {
  return (
    <CardShell item={item} highlight={connected.length > 0}>
      {/* Connected project rows */}
      {connected.length > 0 && (
        <ul className="mb-4 space-y-2">
          {connected.map((row) => (
            <li key={row.id} className="rounded-lg border border-inari-border bg-zinc-900/60 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-300 truncate">{row.projectName}</p>
                  <p className="text-xs font-mono text-zinc-500">
                    {row.isActive ? (
                      <span className="text-green-500">active</span>
                    ) : (
                      <span className="text-red-500">inactive</span>
                    )}
                    {row.lastCheckedAt && (
                      <span className="ml-1.5 text-zinc-600">· {formatRelativeTime(row.lastCheckedAt)}</span>
                    )}
                    {row.errorCount > 0 && (
                      <span className="ml-1.5 text-red-400">· {row.errorCount} err</span>
                    )}
                  </p>
                </div>
                {/* Actions */}
                <div className="flex shrink-0 items-center gap-1">
                  <ConfigModal
                    integrationId={row.id}
                    service={row.service}
                    currentConfig={decryptConfig(row.configEncrypted)}
                  >
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
                      title="Configure"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </button>
                  </ConfigModal>
                  <form action={disconnectIntegration.bind(null, row.id)}>
                    <button
                      type="submit"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors"
                      title="Disconnect"
                    >
                      <Unplug className="h-3.5 w-3.5" />
                    </button>
                  </form>
                </div>
              </div>
              {row.webhookSecret && (
                <WebhookInfo
                  integrationId={row.id}
                  service={row.service}
                  webhookSecret={row.webhookSecret}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Connect button */}
      <div className="mt-auto">
        <ConnectModal
          service={item.service}
          label={item.label}
          projects={projectOptions}
        >
          <Button variant={connected.length > 0 ? "outline" : "primary"} size="sm" className="w-full">
            {connected.length > 0 ? "+ Add another project" : `Connect ${item.label}`}
          </Button>
        </ConnectModal>
      </div>
    </CardShell>
  );
}

function CliCard({
  item,
  connected,
}: {
  item: (typeof CATALOG)[number] & { mode: "cli"; cmd: string };
  connected: ConnectedRow[];
}) {
  return (
    <CardShell item={item} highlight={connected.length > 0}>
      {connected.length > 0 && (
        <ul className="mb-4 space-y-2">
          {connected.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 rounded-lg border border-inari-border bg-zinc-900/60 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-300 truncate">{row.projectName}</p>
                <p className="text-xs font-mono text-zinc-500">
                  {row.isActive ? (
                    <span className="text-green-500">active</span>
                  ) : (
                    <span className="text-red-500">inactive</span>
                  )}
                </p>
              </div>
              <form action={disconnectIntegration.bind(null, row.id)}>
                <button
                  type="submit"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors"
                  title="Disconnect"
                >
                  <Unplug className="h-3.5 w-3.5" />
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {/* CLI-only notice */}
      <div className="mt-auto rounded-lg border border-[#1a1a1a] bg-[#080808] px-3.5 py-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <Terminal className="h-3.5 w-3.5 text-zinc-600" />
          <span className="text-xs text-zinc-500 uppercase tracking-wider">Requires the InariWatch CLI</span>
        </div>
        <p className="text-sm text-zinc-500 leading-relaxed">
          This integration runs locally on your machine and is configured via the CLI.
        </p>
      </div>
    </CardShell>
  );
}

