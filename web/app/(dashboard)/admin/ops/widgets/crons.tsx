import { fetchOps } from "@/lib/ops/client";
import { Card, EmptyState, ErrorState } from "./card";

type LogsResponse = { service: string; lines: number; output: string };

// Parse journalctl output (short-iso format) for "[cron] JOBNAME: <result>" lines
// written by the Go staging orchestrator. Real line example:
//   2026-04-19T07:51:13+00:00 inari-staging inari-staging[1609242]: 2026/04/19 07:51:13 [cron] poll: ok (200) [5.526s]
// The ".*?" before "[cron]" absorbs the app's own timestamp (written by
// Go's stdlib logger) that sits between the journal prefix and the [cron] tag.
function parseCronLines(output: string): {
  job: string;
  lastRun: string;
  status: string;
}[] {
  const latestByJob = new Map<string, { lastRun: string; status: string }>();
  const re = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+\-]\d{2}:\d{2})\s+\S+\s+\S+:\s+.*?\[cron\]\s+([\w\-]+):\s*(.+?)\s*$/;
  for (const line of output.split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    const [, ts, job, status] = m;
    const prev = latestByJob.get(job);
    if (!prev || ts > prev.lastRun) {
      latestByJob.set(job, { lastRun: ts, status });
    }
  }
  return Array.from(latestByJob.entries())
    .map(([job, v]) => ({ job, ...v }))
    .sort((a, b) => a.job.localeCompare(b.job));
}

function relTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export async function CronsWidget() {
  const r = await fetchOps<LogsResponse>("inari-staging", "/logs/inari-staging?lines=500");
  const jobs = r.ok ? parseCronLines(r.data.output) : [];
  return (
    <Card
      title="Go cron jobs"
      subtitle="from inari-staging orchestrator journal"
      className="md:col-span-2"
    >
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : jobs.length === 0 ? (
        <EmptyState message="No [cron] lines found in last 500 log entries." />
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line">
              <th className="text-left font-medium text-fg-base/60 pb-2">Job</th>
              <th className="text-left font-medium text-fg-base/60 pb-2">Last run</th>
              <th className="text-left font-medium text-fg-base/60 pb-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {jobs.map((j) => {
              const ok = /^ok/i.test(j.status);
              return (
                <tr key={j.job}>
                  <td className="py-2 font-mono">{j.job}</td>
                  <td className="py-2 font-mono text-fg-base/70">{relTime(j.lastRun)}</td>
                  <td className={`py-2 font-mono ${ok ? "text-emerald-500" : "text-red-500"}`}>
                    {j.status}
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
