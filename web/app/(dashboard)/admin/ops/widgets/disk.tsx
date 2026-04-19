import { fetchOps, boxLabel, type Box } from "@/lib/ops/client";
import { Card, ErrorState } from "./card";

type HostInfo = {
  hostname: string;
  uptime_secs: number;
  disk_root: {
    total_bytes: number;
    available_bytes: number;
    used_bytes: number;
    used_percent: number;
  };
  memory_mb: Record<string, number>;
  load_avg: [number, number, number];
};

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1) + " GB";
}

function uptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

export async function DiskWidget({ box }: { box: Box }) {
  const r = await fetchOps<HostInfo>(box, "/host");
  return (
    <Card
      title={`${boxLabel(box)} — host`}
      subtitle={r.ok ? r.data.hostname : undefined}
    >
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : (
        <div className="space-y-3">
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-fg-base/60 text-xs">Disk /</span>
              <span
                className={`font-mono text-xs ${
                  r.data.disk_root.used_percent >= 80
                    ? "text-red-500"
                    : r.data.disk_root.used_percent >= 60
                      ? "text-amber-500"
                      : "text-fg-base"
                }`}
              >
                {r.data.disk_root.used_percent}%
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-surface-dim overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  r.data.disk_root.used_percent >= 80
                    ? "bg-red-500"
                    : r.data.disk_root.used_percent >= 60
                      ? "bg-amber-500"
                      : "bg-inari-accent"
                }`}
                style={{ width: `${r.data.disk_root.used_percent}%` }}
              />
            </div>
            <div className="mt-1 text-[11px] text-fg-base/50">
              {gb(r.data.disk_root.used_bytes)} used / {gb(r.data.disk_root.total_bytes)} total · {gb(r.data.disk_root.available_bytes)} free
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-fg-base/60">Memory</div>
              <div className="mt-0.5 font-mono">
                {((r.data.memory_mb.MemTotal ?? 0) - (r.data.memory_mb.MemAvailable ?? 0))}/{r.data.memory_mb.MemTotal ?? 0} MB
              </div>
            </div>
            <div>
              <div className="text-fg-base/60">Load avg</div>
              <div className="mt-0.5 font-mono">
                {r.data.load_avg.map((n) => n.toFixed(2)).join(" ")}
              </div>
            </div>
            <div>
              <div className="text-fg-base/60">Uptime</div>
              <div className="mt-0.5 font-mono">{uptime(r.data.uptime_secs)}</div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
