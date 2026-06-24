import { fetchOps, boxLabel, type Box } from "@/lib/ops/client";
import { Card, EmptyState, ErrorState } from "./card";

type JailStatus = {
  jail: string;
  banned_count: number;
  failed_count: number;
  banned_ips?: string[];
};

type Fail2banResponse =
  | { installed: false }
  | { installed: true; jails: JailStatus[] };

export async function BansWidget({ box }: { box: Box }) {
  const r = await fetchOps<Fail2banResponse>(box, "/fail2ban");
  return (
    <Card title={`${boxLabel(box)} — fail2ban`}>
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : !r.data.installed ? (
        <EmptyState message="fail2ban not installed on this box." />
      ) : r.data.jails.length === 0 ? (
        <EmptyState message="No jails configured." />
      ) : (
        <ul className="space-y-3">
          {r.data.jails.map((j) => (
            <li key={j.jail}>
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-xs">{j.jail}</span>
                <span
                  className={`font-mono text-xs ${j.banned_count > 0 ? "text-amber-500" : "text-fg-base/60"}`}
                >
                  {j.banned_count} banned
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-fg-base/50">
                {j.failed_count} failed total
                {j.banned_ips && j.banned_ips.length > 0 ? (
                  <> · recent: <span className="font-mono">{j.banned_ips.slice(0, 3).join(" ")}</span>{j.banned_ips.length > 3 ? ` +${j.banned_ips.length - 3}` : ""}</>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
