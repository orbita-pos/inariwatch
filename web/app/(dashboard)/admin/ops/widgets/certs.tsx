import { fetchOps, boxLabel, type Box } from "@/lib/ops/client";
import { Card, EmptyState, ErrorState } from "./card";

type CertInfo = {
  domain: string;
  not_after: string;
  days_left: number;
  issuer: string;
  path: string;
};

type CertsResponse = { certs: CertInfo[] | null };

export async function CertsWidget({ box }: { box: Box }) {
  const r = await fetchOps<CertsResponse>(box, "/certs", { revalidate: 3600 });
  const certs = r.ok ? (r.data.certs ?? []) : [];
  const minDays = certs.reduce(
    (acc, c) => (c.days_left < acc ? c.days_left : acc),
    Number.POSITIVE_INFINITY,
  );
  return (
    <Card
      title={`${boxLabel(box)} — TLS certs`}
      subtitle={
        r.ok && certs.length > 0
          ? `${certs.length} cert${certs.length === 1 ? "" : "s"} · min ${minDays}d`
          : undefined
      }
    >
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : certs.length === 0 ? (
        <EmptyState message="No certs found on this box." />
      ) : (
        <ul className="divide-y divide-line -my-2">
          {certs.slice(0, 10).map((c) => (
            <li key={c.path} className="py-2 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs truncate">{c.domain}</div>
                <div className="mt-0.5 text-[11px] text-fg-base/50 truncate">
                  {c.issuer} · expires {c.not_after.slice(0, 10)}
                </div>
              </div>
              <span
                className={`font-mono text-xs whitespace-nowrap ${
                  c.days_left < 14
                    ? "text-red-500"
                    : c.days_left < 30
                      ? "text-amber-500"
                      : "text-fg-base/70"
                }`}
              >
                {c.days_left}d
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
