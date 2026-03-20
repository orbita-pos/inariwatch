import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectIntegrations } from "@/lib/db";
import { eq, inArray, isNull, and } from "drizzle-orm";
import { getActiveOrgId } from "@/lib/workspace";
import { formatRelativeTime } from "@/lib/utils";
import {
  CheckCircle2, XCircle, Clock, Plus,
  Terminal, Settings2, Unplug,
} from "lucide-react";
import {
  GitHubIcon, VercelIcon, SentryIcon, PostgreSQLIcon, NpmIcon, GitIcon, UptimeIcon,
} from "@/components/brand-icons";
import type { ElementType } from "react";
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
    service: "github",
    label:   "GitHub",
    desc:    "Stale PRs, failed CI runs, unreviewed pull requests",
    icon:    GitHubIcon,
    mode:    "web" as const,
  },
  {
    service: "vercel",
    label:   "Vercel",
    desc:    "Failed deployments, build errors, preview failures",
    icon:    VercelIcon,
    mode:    "web" as const,
  },
  {
    service: "sentry",
    label:   "Sentry",
    desc:    "New errors, frequency spikes, affected users",
    icon:    SentryIcon,
    mode:    "web" as const,
  },
  {
    service: "uptime",
    label:   "Uptime Monitor",
    desc:    "HTTP endpoint health checks, response time monitoring",
    icon:    UptimeIcon,
    mode:    "web" as const,
  },
  {
    service: "git",
    label:   "Git local",
    desc:    "Unpushed commits, stale branches — runs on your machine",
    icon:    GitIcon,
    mode:    "cli" as const,
    cmd:     "inari add git",
  },
  {
    service: "postgres",
    label:   "PostgreSQL",
    desc:    "Slow queries, connection spikes, table growth",
    icon:    PostgreSQLIcon,
    mode:    "web" as const,
  },
  {
    service: "npm",
    label:   "npm / Cargo",
    desc:    "CVE alerts on your dependencies",
    icon:    NpmIcon,
    mode:    "web" as const,
  },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function IntegrationsPage() {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;

  const activeOrgId = await getActiveOrgId();

  const userProjects = userId
    ? activeOrgId
      ? await db.select().from(projects).where(eq(projects.organizationId, activeOrgId))
      : await db.select().from(projects).where(and(eq(projects.userId, userId), isNull(projects.organizationId)))
    : [];

  const projectIds     = userProjects.map((p) => p.id);
  const projectNameMap = new Map(userProjects.map((p) => [p.id, p.name]));

  const allIntegrations =
    projectIds.length > 0
      ? (await db.select().from(projectIntegrations).where(inArray(projectIntegrations.projectId, projectIds)))
          .map((r) => ({ ...r, projectName: projectNameMap.get(r.projectId) ?? "" }))
      : [];

  const projectOptions = userProjects.map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="space-y-8">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">Integrations</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Connect your services. InariWatch polls them every 1 minute and surfaces alerts automatically.
          </p>
        </div>
        <CreateProjectModal organizationId={activeOrgId}>
          <Button variant="primary" size="sm" className="shrink-0 gap-1.5">
            <Plus className="h-3.5 w-3.5" /> New project
          </Button>
        </CreateProjectModal>
      </div>

      {/* ── No projects ────────────────────────────────────────────────── */}
      {userProjects.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-20 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface-dim">
            <span className="text-base text-zinc-600">◉</span>
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-400">No projects yet</p>
            <p className="mt-1 text-sm text-zinc-600">
              Create a project to start connecting integrations.
            </p>
          </div>
          <CreateProjectModal organizationId={activeOrgId}>
            <Button variant="primary" size="sm" className="mt-1 gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Create first project
            </Button>
          </CreateProjectModal>
        </div>
      )}

      {/* ── Integration cards ──────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CATALOG.map((item) => {
          const connected = allIntegrations.filter((i) => i.service === item.service);

          if (item.mode === "cli") {
            return (
              <CliCard key={item.service} item={item} connected={connected} />
            );
          }

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

// ── Types ──────────────────────────────────────────────────────────────────────

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

// ── Card shell ─────────────────────────────────────────────────────────────────

function CardShell({
  item,
  connected,
  children,
}: {
  item: { label: string; desc: string; icon: ElementType };
  connected: ConnectedRow[];
  children: React.ReactNode;
}) {
  const Icon      = item.icon;
  const isActive  = connected.length > 0;
  const hasErrors = connected.some((c) => c.errorCount > 0);

  return (
    <div className={`relative flex flex-col overflow-hidden rounded-xl border bg-surface transition-all ${
      isActive ? "border-line-medium" : "border-line"
    }`}>
      {/* Top accent bar when connected */}
      {isActive && (
        <div className={`h-[2px] w-full ${hasErrors ? "bg-amber-400/60" : "bg-green-500/40"}`} />
      )}

      <div className="flex flex-1 flex-col p-5">
        {/* Icon + title */}
        <div className="mb-3 flex items-center gap-3">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
            isActive ? "border-line-medium bg-surface-dim text-fg-base" : "border-line bg-surface-dim text-zinc-500"
          }`}>
            <Icon className="h-[18px] w-[18px]" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-fg-base">{item.label}</span>
            {isActive && (
              <span className={`h-1.5 w-1.5 rounded-full ${hasErrors ? "bg-amber-400" : "bg-green-500"}`} />
            )}
          </div>
        </div>

        <p className="mb-4 text-sm leading-relaxed text-zinc-500">{item.desc}</p>

        {children}
      </div>
    </div>
  );
}

// ── Web card ───────────────────────────────────────────────────────────────────

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
    <CardShell item={item} connected={connected}>
      {/* Connected project rows */}
      {connected.length > 0 && (
        <ul className="mb-4 space-y-2">
          {connected.map((row) => (
            <li
              key={row.id}
              className="overflow-hidden rounded-lg border border-line bg-surface-inner"
            >
              <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg-base">{row.projectName}</p>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs">
                    {row.isActive ? (
                      <>
                        <CheckCircle2 className="h-3 w-3 text-green-500" />
                        <span className="text-green-600">active</span>
                      </>
                    ) : (
                      <>
                        <XCircle className="h-3 w-3 text-red-500/70" />
                        <span className="text-red-600">inactive</span>
                      </>
                    )}
                    {row.lastCheckedAt && (
                      <span className="text-zinc-700">
                        <Clock className="mr-0.5 inline h-2.5 w-2.5" />
                        {formatRelativeTime(row.lastCheckedAt)}
                      </span>
                    )}
                    {row.errorCount > 0 && (
                      <span className="text-amber-500/80">{row.errorCount} err</span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-0.5">
                  <ConfigModal
                    integrationId={row.id}
                    service={row.service}
                    currentConfig={decryptConfig(row.configEncrypted)}
                  >
                    <button
                      type="button"
                      title="Configure"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.06] hover:text-fg-base"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </button>
                  </ConfigModal>
                  <form action={disconnectIntegration.bind(null, row.id)}>
                    <button
                      type="submit"
                      title="Disconnect"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-red-400/[0.06] hover:text-red-400"
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
        <ConnectModal service={item.service} label={item.label} projects={projectOptions}>
          <Button
            variant={connected.length > 0 ? "outline" : "primary"}
            size="sm"
            className="w-full"
          >
            {connected.length > 0 ? "+ Add another project" : `Connect ${item.label}`}
          </Button>
        </ConnectModal>
      </div>
    </CardShell>
  );
}

// ── CLI card ───────────────────────────────────────────────────────────────────

function CliCard({
  item,
  connected,
}: {
  item: (typeof CATALOG)[number] & { mode: "cli"; cmd: string };
  connected: ConnectedRow[];
}) {
  return (
    <CardShell item={item} connected={connected}>
      {connected.length > 0 && (
        <ul className="mb-4 space-y-2">
          {connected.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-inner px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-fg-base">{row.projectName}</p>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs">
                  {row.isActive ? (
                    <>
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                      <span className="text-green-600">active</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-3 w-3 text-red-500/70" />
                      <span className="text-red-600">inactive</span>
                    </>
                  )}
                </div>
              </div>
              <form action={disconnectIntegration.bind(null, row.id)}>
                <button
                  type="submit"
                  title="Disconnect"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-red-400/[0.06] hover:text-red-400"
                >
                  <Unplug className="h-3.5 w-3.5" />
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {/* CLI notice */}
      <div className="mt-auto rounded-lg border border-line bg-surface-inner px-3.5 py-3">
        <div className="mb-1.5 flex items-center gap-1.5">
          <Terminal className="h-3.5 w-3.5 text-zinc-600" />
          <span className="text-[11px] font-medium uppercase tracking-widest text-zinc-600">
            Requires the CLI
          </span>
        </div>
        <p className="text-sm leading-relaxed text-zinc-500">
          This integration runs locally on your machine.
        </p>
        <p className="mt-2 font-mono text-xs text-zinc-600">
          $ {item.cmd}
        </p>
      </div>
    </CardShell>
  );
}
