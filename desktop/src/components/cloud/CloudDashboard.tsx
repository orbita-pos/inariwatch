/**
 * v0.3 Phase A — right-side cloud dashboard panel.
 *
 * Renders 6 read-only widgets fed by `lib/cloud-ipc.ts`:
 *   1. Status summary
 *   2. Alerts (live via `cloud-alerts-update` SSE event + manual refresh)
 *   3. Uptime
 *   4. Deploys
 *   5. On-call
 *   6. Community trending
 *
 * States per card: loading → data | empty | error. The panel as a whole
 * collapses to a single chevron strip so users who don't want the cloud
 * layer see ZERO perf cost (no fetches fire while collapsed).
 *
 * Auth lifecycle:
 *   - On mount, queries `desktopAuthStatus`. If not connected, renders
 *     ConnectEmptyState.
 *   - Listens for `cloud-auth-required` Tauri event (any 401 anywhere)
 *     and flips back to ConnectEmptyState.
 *   - "Connect" button kicks off the device flow via `desktopAuthStart`
 *     then `desktopAuthPoll` → on success, all widgets refetch.
 */

import {
  AlertTriangle,
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  RefreshCw,
  Search,
  Server,
  Shield,
  Sparkles,
  Users,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { FixLocallyDialog } from "@/components/fix/FixLocallyDialog";
import { SearchPanel } from "@/components/search/SearchPanel";
import { Button, Card, Dialog } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  CloudError,
  cloudAuthPoll,
  cloudAuthStart,
  cloudAuthStatus,
  cloudGetAlerts,
  cloudGetCommunityTrending,
  cloudGetDeploys,
  cloudGetOncall,
  cloudGetStatusSummary,
  cloudGetUptime,
  type AuthStatus,
  type CloudAlert,
  type DeploySummary,
  type OncallStatus,
  type StatusSummary,
  type TrendingFix,
  type UptimeSummary,
} from "@/lib/cloud-ipc";
import {
  setCardCollapsed,
  togglePanel,
  useCloudPanel,
  type CardId,
} from "@/lib/store/cloudPanel";

const REFRESH_INTERVAL_MS = 30_000;

// Subscribe to a Tauri event without hard-failing under jsdom.
function useTauriEvent(name: string, handler: () => void) {
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    const load = async () => {
      try {
        // Late-import so vitest doesn't need to mock @tauri-apps/api/event.
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        const fn = await listen(name, handler);
        if (cancelled) {
          fn();
          return;
        }
        unlistenFn = fn;
      } catch {
        /* tauri runtime not present — silent. */
      }
    };
    load();
    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, [name, handler]);
}

// ── Empty / connect ──────────────────────────────────────────────────

interface ConnectStateProps {
  status: "checking" | "disconnected" | "connecting" | "connected";
  onConnect: () => void;
  message?: string | null;
}

function ConnectEmptyState({ status, onConnect, message }: ConnectStateProps) {
  return (
    <div
      data-testid="cloud-empty-state"
      className="flex flex-col gap-3 items-start p-5 text-sm"
    >
      <div className="flex items-center gap-2 text-[var(--text)]">
        <Shield className="h-4 w-4" aria-hidden />
        <span className="font-medium">Cloud dashboard</span>
      </div>
      <p className="text-xs text-[var(--muted)]">
        Connect Inari Live to your InariWatch workspace to see live alerts,
        uptime, deploys, on-call rotations, and community fixes here.
      </p>
      <Button
        size="sm"
        variant="primary"
        onClick={onConnect}
        disabled={status === "connecting" || status === "checking"}
        data-testid="cloud-connect-button"
      >
        {status === "connecting" ? "Opening browser…" : "Connect to InariWatch Cloud"}
      </Button>
      {message ? (
        <p className="text-xs text-[var(--danger)]">{message}</p>
      ) : null}
    </div>
  );
}

// ── Card chrome ──────────────────────────────────────────────────────

interface WidgetCardProps {
  id: CardId;
  title: string;
  icon: typeof Bell;
  loading: boolean;
  error: string | null;
  lastRefresh: Date | null;
  onRefresh: () => void;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function WidgetCard({
  id,
  title,
  icon: Icon,
  loading,
  error,
  lastRefresh,
  onRefresh,
  collapsed,
  onToggle,
  children,
}: WidgetCardProps) {
  return (
    <Card
      data-testid={`cloud-widget-${id}`}
      data-collapsed={collapsed ? "true" : "false"}
      noPadding
      className="flex flex-col"
    >
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex items-center gap-2 px-3 py-2 text-left",
          "hover:bg-[var(--surface)] rounded-t-[var(--radius-lg)]",
          "transition-colors duration-[var(--duration-fast)]",
        )}
        aria-expanded={!collapsed}
        data-testid={`cloud-widget-${id}-toggle`}
      >
        <Icon className="h-3.5 w-3.5 text-[var(--muted)]" aria-hidden />
        <span className="text-xs font-medium flex-1">{title}</span>
        {loading ? (
          <RefreshCw
            className="h-3 w-3 text-[var(--muted)] animate-spin"
            aria-label="loading"
          />
        ) : null}
        {lastRefresh ? (
          <span className="text-[0.65rem] text-[var(--muted)]">
            {formatTimeAgo(lastRefresh)}
          </span>
        ) : null}
        {collapsed ? (
          <ChevronRight className="h-3 w-3 text-[var(--muted)]" aria-hidden />
        ) : (
          <ChevronDown className="h-3 w-3 text-[var(--muted)]" aria-hidden />
        )}
      </button>
      {!collapsed ? (
        <div className="px-3 pb-3 pt-0">
          {error ? (
            <div
              className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-2 text-xs"
              data-testid={`cloud-widget-${id}-error`}
            >
              <AlertTriangle
                className="h-3.5 w-3.5 text-[var(--danger)] mt-0.5"
                aria-hidden
              />
              <div className="flex-1">
                <div className="text-[var(--text)]">Couldn't load.</div>
                <div className="text-[var(--muted)]">{error}</div>
              </div>
              <button
                type="button"
                className="text-[var(--accent)] hover:underline"
                onClick={onRefresh}
              >
                Retry
              </button>
            </div>
          ) : (
            children
          )}
        </div>
      ) : null}
    </Card>
  );
}

// ── Per-widget bodies ────────────────────────────────────────────────

function StatusBody({ data, loading }: { data: StatusSummary | null; loading: boolean }) {
  if (loading && !data) return <SkeletonRows n={2} />;
  if (!data) return null;
  const dot = STATE_DOT[data.state] ?? "bg-[var(--muted)]";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />
        <span className="capitalize">{data.state}</span>
      </div>
      <div className="text-xs text-[var(--muted)] grid grid-cols-2 gap-1">
        <span>Critical (24h):</span>
        <span className="text-right text-[var(--text)]">
          {data.alertsCritical24h}
        </span>
        <span>Warning (24h):</span>
        <span className="text-right text-[var(--text)]">
          {data.alertsWarning24h}
        </span>
        <span>Monitors down:</span>
        <span className="text-right text-[var(--text)]">
          {data.monitorsDown}/{data.monitorsTotal}
        </span>
        <span>Projects:</span>
        <span className="text-right text-[var(--text)]">{data.projectCount}</span>
      </div>
    </div>
  );
}

const STATE_DOT: Record<string, string> = {
  operational: "bg-[var(--success)]",
  degraded:    "bg-[var(--warning)]",
  outage:      "bg-[var(--danger)]",
};

function AlertsBody({
  data,
  loading,
  onFindSources,
  onFixLocally,
}: {
  data: CloudAlert[] | null;
  loading: boolean;
  /**
   * S13 — fired when the user clicks "Find sources" on an alert row.
   * The panel opens a Dialog hosting `SearchPanel` for that alert's
   * `body || title` text. Defined as a prop (not an internal state)
   * so the parent owns the modal's open/close lifecycle.
   */
  onFindSources: (alert: CloudAlert) => void;
  /** Fix Locally — open the FixLocallyDialog for the selected alert. */
  onFixLocally: (alert: CloudAlert) => void;
}) {
  if (loading && !data) return <SkeletonRows n={3} />;
  if (!data || data.length === 0) {
    return (
      <p className="text-xs text-[var(--muted)]">No unread alerts.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {data.slice(0, 5).map((a) => (
        <li
          key={a.id}
          className="flex flex-col gap-1.5 text-xs"
          data-testid={`cloud-alert-row-${a.id}`}
        >
          <div className="flex items-start gap-2">
            <span
              className={cn(
                "h-2 w-2 rounded-full mt-1.5 shrink-0",
                SEVERITY_DOT[a.severity] ?? "bg-[var(--muted)]",
              )}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[var(--text)]">{a.title}</div>
              <div className="text-[var(--muted)]">{a.projectName}</div>
            </div>
          </div>
          {/* S13 — Find sources + Fix Locally row */}
          <div className="ml-4 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => onFindSources(a)}
              data-testid={`cloud-alert-find-sources-${a.id}`}
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5",
                "text-[0.65rem] text-[var(--muted)] hover:text-[var(--accent)]",
                "rounded-[var(--radius-sm)] hover:bg-[var(--surface)]",
                "transition-colors duration-[var(--duration-fast)]",
              )}
            >
              <Search className="h-3 w-3" aria-hidden />
              Find sources
            </button>
            <button
              type="button"
              onClick={() => onFixLocally(a)}
              data-testid={`cloud-alert-fix-locally-${a.id}`}
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5",
                "text-[0.65rem] text-[var(--muted)] hover:text-[var(--accent)]",
                "rounded-[var(--radius-sm)] hover:bg-[var(--surface)]",
                "transition-colors duration-[var(--duration-fast)]",
              )}
            >
              <Wrench className="h-3 w-3" aria-hidden />
              Fix locally
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-[var(--danger)]",
  warning:  "bg-[var(--warning)]",
  info:     "bg-[var(--accent)]",
};

function UptimeBody({
  data,
  loading,
}: {
  data: UptimeSummary | null;
  loading: boolean;
}) {
  if (loading && !data) return <SkeletonRows n={2} />;
  if (!data) return null;
  if (data.total === 0) {
    return <p className="text-xs text-[var(--muted)]">No uptime monitors configured.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-xs">
        <span className="text-[var(--muted)]">Up</span>
        <span className="text-[var(--text)]">
          {data.total - data.downCount}/{data.total}
        </span>
      </div>
      {data.avgResponseMs !== null ? (
        <div className="flex justify-between text-xs">
          <span className="text-[var(--muted)]">Avg response</span>
          <span className="text-[var(--text)]">{data.avgResponseMs}ms</span>
        </div>
      ) : null}
      {data.downCount > 0 ? (
        <ul className="flex flex-col gap-0.5 mt-1">
          {data.monitors
            .filter((m) => m.consecutiveFailures > 0)
            .slice(0, 3)
            .map((m) => (
              <li
                key={m.id}
                className="text-xs text-[var(--danger)] truncate"
                data-testid={`cloud-uptime-down-${m.id}`}
              >
                {m.name ?? m.url}
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}

function DeploysBody({
  data,
  loading,
}: {
  data: DeploySummary | null;
  loading: boolean;
}) {
  if (loading && !data) return <SkeletonRows n={2} />;
  if (!data || data.deploys.length === 0) {
    return <p className="text-xs text-[var(--muted)]">No recent deploys.</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {data.deploys.slice(0, 4).map((d) => (
        <li
          key={d.id}
          className="flex items-center gap-2 text-xs"
          data-testid={`cloud-deploy-row-${d.id}`}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full shrink-0",
              DEPLOY_STATE_DOT[d.state] ?? "bg-[var(--muted)]",
            )}
            aria-hidden
          />
          <span className="truncate flex-1 text-[var(--text)]">{d.title}</span>
          <span className="text-[var(--muted)]">{d.projectName}</span>
        </li>
      ))}
    </ul>
  );
}

const DEPLOY_STATE_DOT: Record<string, string> = {
  success:  "bg-[var(--success)]",
  failed:   "bg-[var(--danger)]",
  building: "bg-[var(--warning)]",
  unknown:  "bg-[var(--muted)]",
};

function OncallBody({
  data,
  loading,
}: {
  data: OncallStatus | null;
  loading: boolean;
}) {
  if (loading && !data) return <SkeletonRows n={2} />;
  if (!data || data.schedules.length === 0) {
    return <p className="text-xs text-[var(--muted)]">No on-call schedules.</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {data.schedules.slice(0, 4).map((s) => (
        <li
          key={s.projectId + s.scheduleName}
          className="text-xs"
          data-testid={`cloud-oncall-row-${s.projectId}`}
        >
          <div className="text-[var(--muted)] truncate">{s.projectName}</div>
          <div className="text-[var(--text)] truncate">
            {s.primary?.name ?? s.primary?.email ?? "(unassigned)"}
            {s.hasActiveOverride ? (
              <span className="ml-1 text-[var(--warning)]">override</span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function CommunityBody({
  data,
  loading,
}: {
  data: TrendingFix[] | null;
  loading: boolean;
}) {
  if (loading && !data) return <SkeletonRows n={2} />;
  if (!data || data.length === 0) {
    return (
      <p className="text-xs text-[var(--muted)]">
        No trending fixes yet.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {data.slice(0, 4).map((f) => (
        <li
          key={f.id}
          className="text-xs"
          data-testid={`cloud-trending-row-${f.id}`}
        >
          <div className="text-[var(--text)] truncate">{f.patternTitle}</div>
          <div className="text-[var(--muted)]">
            {f.successRate}% success · {f.totalApplications} runs
          </div>
        </li>
      ))}
    </ul>
  );
}

function SkeletonRows({ n }: { n: number }) {
  return (
    <div className="flex flex-col gap-1.5" aria-hidden>
      {Array.from({ length: n }).map((_, i) => (
        <div
          key={i}
          className="h-3 rounded bg-[var(--surface)] animate-pulse"
        />
      ))}
    </div>
  );
}

function formatTimeAgo(d: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 5)   return "now";
  if (sec < 60)  return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// ── Per-widget hook (one local cache + refresh fn each) ──────────────

function useWidget<T>(
  fetcher: () => Promise<T>,
  enabled: boolean,
  reloadKey: number,
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetcher();
      setData(next);
      setLastRefresh(new Date());
    } catch (err) {
      const e = err as CloudError;
      // not_connected / unauthorized / ipc_unavailable surface elsewhere —
      // keep card calm.
      if (e?.kind === "ipc_unavailable" || e?.kind === "not_connected") {
        setData(null);
        setError(null);
      } else {
        setError(e?.message ?? "Failed");
      }
    } finally {
      setLoading(false);
    }
    // refresh fn is intentionally stable across re-renders for the
    // 30s timer to keep working without re-arming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fetcher]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const t = setInterval(() => refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reloadKey]);

  return { data, loading, error, lastRefresh, refresh };
}

// ── The panel ────────────────────────────────────────────────────────

export function CloudDashboard() {
  const { panelOpen, cardCollapsed } = useCloudPanel();
  const [authStatus, setAuthStatus] =
    useState<"checking" | "disconnected" | "connecting" | "connected">("checking");
  const [authError, setAuthError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const initRanRef = useRef(false);

  // S13 — modal state for "Find sources". Owned at the panel level
  // (not inside AlertsBody) so the Dialog stays mounted as a sibling
  // and a future "Find sources for related deploy/uptime row" can
  // share the same modal. `findSourcesAlert` doubles as the
  // open-state — when null, the Dialog is closed.
  const [findSourcesAlert, setFindSourcesAlert] = useState<CloudAlert | null>(null);
  // Fix Locally — same pattern as findSourcesAlert.
  const [fixLocallyAlert, setFixLocallyAlert] = useState<CloudAlert | null>(null);

  const checkAuth = useCallback(async () => {
    try {
      const status: AuthStatus = await cloudAuthStatus();
      setAuthStatus(status.connected ? "connected" : "disconnected");
      // Clear any stale "Session expired" error left over from a 401
      // event that has since been resolved (re-pair, transient blip).
      if (status.connected) setAuthError(null);
    } catch (err) {
      const e = err as CloudError;
      // Inside vitest / jsdom the IPC isn't there — render disconnected
      // so the panel still snapshots cleanly.
      if (e?.kind === "ipc_unavailable") {
        setAuthStatus("disconnected");
      } else {
        setAuthStatus("disconnected");
        setAuthError(e?.message ?? "Auth check failed");
      }
    }
  }, []);

  useEffect(() => {
    if (initRanRef.current) return;
    initRanRef.current = true;
    checkAuth();
  }, [checkAuth]);

  // 401 anywhere → reconnect surface.
  useTauriEvent("cloud-auth-required", () => {
    setAuthStatus("disconnected");
    setAuthError("Session expired. Please reconnect.");
  });

  // Live alerts → bump reloadKey so each widget refetches.
  useTauriEvent("cloud-alerts-update", () => {
    setReloadKey((k) => k + 1);
  });

  const handleConnect = useCallback(async () => {
    setAuthStatus("connecting");
    setAuthError(null);
    try {
      const started = await cloudAuthStart();
      // Long-poll the device flow. The Rust side also persists the token,
      // so on success we just re-check status.
      await cloudAuthPoll(started.code, started.api_url);
      setAuthStatus("connected");
      setReloadKey((k) => k + 1);
    } catch (err) {
      const e = err as CloudError;
      setAuthStatus("disconnected");
      setAuthError(e?.message ?? "Connection failed");
    }
  }, []);

  const enabled = panelOpen && authStatus === "connected";

  const status   = useWidget(cloudGetStatusSummary, enabled, reloadKey);
  const alerts   = useWidget(() => cloudGetAlerts(20), enabled, reloadKey);
  const uptime   = useWidget(cloudGetUptime, enabled, reloadKey);
  const deploys  = useWidget(() => cloudGetDeploys(8), enabled, reloadKey);
  const oncall   = useWidget(cloudGetOncall, enabled, reloadKey);
  const trending = useWidget(
    () => cloudGetCommunityTrending(8),
    enabled,
    reloadKey,
  );

  if (!panelOpen) {
    return (
      <button
        type="button"
        onClick={togglePanel}
        data-testid="cloud-panel-rail-collapsed"
        className={cn(
          "h-full w-8 shrink-0 border-l border-[var(--border)]",
          "flex items-center justify-center",
          "bg-[var(--surface)] hover:bg-[var(--card)]",
          "transition-colors duration-[var(--duration-fast)]",
        )}
        aria-label="Show cloud dashboard"
      >
        <ChevronLeft className="h-4 w-4 text-[var(--muted)]" aria-hidden />
      </button>
    );
  }

  return (
    <aside
      data-testid="cloud-panel"
      data-auth={authStatus}
      className={cn(
        "h-full w-[300px] shrink-0 border-l border-[var(--border)]",
        "bg-[var(--bg)] flex flex-col",
      )}
    >
      <header className="flex items-center gap-2 px-3 h-9 border-b border-[var(--border)]">
        <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden />
        <span className="text-xs font-medium flex-1">InariWatch Cloud</span>
        <button
          type="button"
          onClick={togglePanel}
          aria-label="Collapse cloud dashboard"
          data-testid="cloud-panel-collapse"
          className="h-5 w-5 grid place-items-center rounded text-[var(--muted)] hover:bg-[var(--surface)]"
        >
          <ChevronRight className="h-3 w-3" aria-hidden />
        </button>
      </header>

      {authStatus === "connected" ? (
        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
          <WidgetCard
            id="status"
            title="Status"
            icon={Shield}
            loading={status.loading}
            error={status.error}
            lastRefresh={status.lastRefresh}
            onRefresh={status.refresh}
            collapsed={cardCollapsed.status}
            onToggle={() => setCardCollapsed("status", !cardCollapsed.status)}
          >
            <StatusBody data={status.data} loading={status.loading} />
          </WidgetCard>

          <WidgetCard
            id="alerts"
            title="Alerts"
            icon={Bell}
            loading={alerts.loading}
            error={alerts.error}
            lastRefresh={alerts.lastRefresh}
            onRefresh={alerts.refresh}
            collapsed={cardCollapsed.alerts}
            onToggle={() => setCardCollapsed("alerts", !cardCollapsed.alerts)}
          >
            <AlertsBody
              data={alerts.data}
              loading={alerts.loading}
              onFindSources={setFindSourcesAlert}
              onFixLocally={setFixLocallyAlert}
            />
          </WidgetCard>

          <WidgetCard
            id="uptime"
            title="Uptime"
            icon={Server}
            loading={uptime.loading}
            error={uptime.error}
            lastRefresh={uptime.lastRefresh}
            onRefresh={uptime.refresh}
            collapsed={cardCollapsed.uptime}
            onToggle={() => setCardCollapsed("uptime", !cardCollapsed.uptime)}
          >
            <UptimeBody data={uptime.data} loading={uptime.loading} />
          </WidgetCard>

          <WidgetCard
            id="deploys"
            title="Deploys"
            icon={GitBranch}
            loading={deploys.loading}
            error={deploys.error}
            lastRefresh={deploys.lastRefresh}
            onRefresh={deploys.refresh}
            collapsed={cardCollapsed.deploys}
            onToggle={() => setCardCollapsed("deploys", !cardCollapsed.deploys)}
          >
            <DeploysBody data={deploys.data} loading={deploys.loading} />
          </WidgetCard>

          <WidgetCard
            id="oncall"
            title="On-call"
            icon={Users}
            loading={oncall.loading}
            error={oncall.error}
            lastRefresh={oncall.lastRefresh}
            onRefresh={oncall.refresh}
            collapsed={cardCollapsed.oncall}
            onToggle={() => setCardCollapsed("oncall", !cardCollapsed.oncall)}
          >
            <OncallBody data={oncall.data} loading={oncall.loading} />
          </WidgetCard>

          <WidgetCard
            id="community"
            title="Community trending"
            icon={Sparkles}
            loading={trending.loading}
            error={trending.error}
            lastRefresh={trending.lastRefresh}
            onRefresh={trending.refresh}
            collapsed={cardCollapsed.community}
            onToggle={() => setCardCollapsed("community", !cardCollapsed.community)}
          >
            <CommunityBody data={trending.data} loading={trending.loading} />
          </WidgetCard>
        </div>
      ) : (
        <ConnectEmptyState
          status={authStatus}
          onConnect={handleConnect}
          message={authError}
        />
      )}
      {/* S13 — Find sources modal */}
      <Dialog
        open={findSourcesAlert !== null}
        onOpenChange={(open) => {
          if (!open) setFindSourcesAlert(null);
        }}
        title={findSourcesAlert ? findSourcesAlert.title : ""}
        description={findSourcesAlert ? `Find sources for ${findSourcesAlert.projectName}` : undefined}
      >
        {findSourcesAlert ? (
          <SearchPanel
            errorText={findSourcesAlert.body || findSourcesAlert.title}
            onClose={() => setFindSourcesAlert(null)}
          />
        ) : null}
      </Dialog>

      {/* Fix Locally modal */}
      <FixLocallyDialog
        alert={fixLocallyAlert}
        onClose={() => setFixLocallyAlert(null)}
      />
    </aside>
  );
}
