import Link from "next/link";
import { AlertTriangle } from "lucide-react";

type BrokenIntegration = {
  id: string;
  service: string;
  projectName: string;
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;
};

/**
 * Red banner shown at the top of /integrations when any connected integration
 * has been auto-disabled after a 401 / auth failure. Passive detection: no
 * extra API calls — the flag comes from real remediation / Preview Fix usage
 * flipping `is_active = false` on a failed call. The banner gives the user a
 * clear next action ("Reconnect") instead of having to discover the broken
 * token through an opaque remediation failure days later.
 */
export function IntegrationHealthBanner({
  broken,
}: {
  broken: BrokenIntegration[];
}) {
  if (broken.length === 0) return null;

  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-400">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-red-300">
            {broken.length === 1
              ? "1 integration needs attention"
              : `${broken.length} integrations need attention`}
          </p>
          <ul className="mt-2 space-y-1.5">
            {broken.map((b) => (
              <li key={b.id} className="text-sm text-fg-base/80">
                <span className="font-medium capitalize text-fg-base">{b.service}</span>
                <span className="text-fg-base/50"> · {b.projectName}</span>
                {b.lastErrorMessage && (
                  <span className="ml-1.5 text-fg-base/60">— {b.lastErrorMessage}</span>
                )}
                {" "}
                <Link
                  href={`#service-${b.service}`}
                  className="font-medium text-red-400 underline-offset-4 hover:underline"
                >
                  Reconnect →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
