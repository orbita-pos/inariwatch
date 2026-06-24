import { fetchOps } from "@/lib/ops/client";
import { Card, ErrorState } from "./card";

type QueueRow = { queue: string; wait: number; active: number; delayed: number; failed: number };
type QueuesResponse = { rows: QueueRow[] | null };

export async function QueuesWidget() {
  // BullMQ lives on the Hetzner-local Redis (docker container on inari-staging),
  // not on Upstash. The ops-agent on inari-staging shells out to redis-cli
  // inside the container and returns counts.
  const r = await fetchOps<QueuesResponse>("inari-staging", "/queues");
  const rows = r.ok ? (r.data.rows ?? []) : [];
  const totalFailed = rows.reduce((acc, row) => acc + row.failed, 0);
  return (
    <Card
      title="BullMQ queues"
      subtitle={r.ok ? (totalFailed > 0 ? `${totalFailed} failed` : "healthy") : undefined}
      className="md:col-span-2"
    >
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line">
              <th className="text-left font-medium text-fg-base/60 pb-2">Queue</th>
              <th className="text-right font-medium text-fg-base/60 pb-2">Waiting</th>
              <th className="text-right font-medium text-fg-base/60 pb-2">Active</th>
              <th className="text-right font-medium text-fg-base/60 pb-2">Delayed</th>
              <th className="text-right font-medium text-fg-base/60 pb-2">Failed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.queue}>
                <td className="py-2 font-mono">{row.queue}</td>
                <td className="py-2 text-right font-mono">{row.wait}</td>
                <td className="py-2 text-right font-mono">{row.active}</td>
                <td className="py-2 text-right font-mono">{row.delayed}</td>
                <td className={`py-2 text-right font-mono ${row.failed > 0 ? "text-red-500" : ""}`}>
                  {row.failed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
