import "server-only";
import { Card, EmptyState, ErrorState } from "./card";

type Run = {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  run_number: number;
  event: string;
  created_at: string;
  updated_at: string;
  run_started_at: string;
  html_url: string;
  actor: { login: string };
  display_title: string;
};

async function fetchDeploys(): Promise<
  | { ok: true; runs: Run[] }
  | { ok: false; error: string }
> {
  const token = process.env.OPS_GITHUB_TOKEN;
  if (!token) return { ok: false, error: "OPS_GITHUB_TOKEN not configured" };
  try {
    const url =
      "https://api.github.com/repos/orbita-pos/inariwatch/actions/workflows/deploy-web.yml/runs?per_page=10";
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      next: { revalidate: 30 },
    });
    if (!res.ok) return { ok: false, error: `GitHub HTTP ${res.status}` };
    const body = (await res.json()) as { workflow_runs: Run[] };
    return { ok: true, runs: body.workflow_runs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function dur(startIso: string, endIso: string): string {
  const secs = Math.floor(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000,
  );
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

function relTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export async function DeploysWidget() {
  const r = await fetchDeploys();
  const lastGood = r.ok
    ? r.runs.find((run) => run.conclusion === "success")
    : undefined;
  return (
    <Card
      title="Deploys"
      subtitle={
        r.ok && lastGood
          ? `last good ${relTime(lastGood.updated_at)} by ${lastGood.actor.login}`
          : undefined
      }
      className="md:col-span-2"
      footer={
        r.ok ? (
          <a
            href="https://github.com/orbita-pos/inariwatch/actions/workflows/deploy-web.yml"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            View all runs on GitHub →
          </a>
        ) : null
      }
    >
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : r.runs.length === 0 ? (
        <EmptyState message="No workflow runs found." />
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line">
              <th className="text-left font-medium text-fg-base/60 pb-2">#</th>
              <th className="text-left font-medium text-fg-base/60 pb-2">Commit</th>
              <th className="text-left font-medium text-fg-base/60 pb-2">By</th>
              <th className="text-left font-medium text-fg-base/60 pb-2">Status</th>
              <th className="text-right font-medium text-fg-base/60 pb-2">Duration</th>
              <th className="text-right font-medium text-fg-base/60 pb-2">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {r.runs.map((run) => {
              const isRunning = run.status !== "completed";
              const badge =
                isRunning
                  ? "text-amber-500"
                  : run.conclusion === "success"
                    ? "text-emerald-500"
                    : "text-red-500";
              return (
                <tr key={run.id}>
                  <td className="py-2 font-mono text-fg-base/60">#{run.run_number}</td>
                  <td className="py-2">
                    <a
                      href={run.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      <span className="font-mono text-[11px] text-fg-base/50">{run.head_sha.slice(0, 7)}</span>
                      <span className="ml-2">{run.display_title}</span>
                    </a>
                  </td>
                  <td className="py-2 text-fg-base/70">{run.actor.login}</td>
                  <td className={`py-2 font-mono ${badge}`}>
                    {isRunning ? run.status : (run.conclusion ?? "?")}
                  </td>
                  <td className="py-2 text-right font-mono text-fg-base/70">
                    {isRunning ? "—" : dur(run.run_started_at, run.updated_at)}
                  </td>
                  <td className="py-2 text-right font-mono text-fg-base/60">
                    {relTime(run.created_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
