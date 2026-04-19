import { fetchOps, boxLabel, type Box } from "@/lib/ops/client";
import { Card, EmptyState, ErrorState } from "./card";

type Container = {
  Names: string;
  Image: string;
  Status: string;
  State: string;
  RunningFor: string;
  Ports?: string;
};

type DockerResponse = { containers: Container[] | null };

export async function ContainersWidget({ box }: { box: Box }) {
  const r = await fetchOps<DockerResponse>(box, "/docker");
  const containers = r.ok ? (r.data.containers ?? []) : [];
  const running = containers.filter((c) => c.State === "running").length;
  return (
    <Card
      title={`${boxLabel(box)} — containers`}
      subtitle={r.ok ? `${running} running · ${containers.length} total` : undefined}
    >
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : containers.length === 0 ? (
        <EmptyState message="No containers." />
      ) : (
        <ul className="divide-y divide-line -my-2">
          {containers.slice(0, 8).map((c) => (
            <li key={c.Names} className="py-2 flex items-start gap-3">
              <span
                className={`mt-1 h-2 w-2 rounded-full flex-shrink-0 ${
                  c.State === "running"
                    ? "bg-emerald-500"
                    : c.State === "exited"
                      ? "bg-fg-base/30"
                      : "bg-amber-500"
                }`}
                title={c.State}
              />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs truncate">{c.Names}</div>
                <div className="mt-0.5 text-[11px] text-fg-base/50 truncate">
                  {c.Image.split("@")[0]}
                </div>
              </div>
              <div className="text-[11px] text-fg-base/60 whitespace-nowrap">
                {c.RunningFor ?? c.Status.slice(0, 20)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
