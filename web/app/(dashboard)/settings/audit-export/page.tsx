import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { db, getUserOrganizations, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { AuditExportForm } from "./audit-export-form";
import { STANDARDS } from "@/lib/services/audit-export";

export const metadata: Metadata = { title: "Audit export — Settings" };
export const dynamic = "force-dynamic";

export default async function AuditExportPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [userRow] = await db
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const orgs = await getUserOrganizations(userId);

  // Standards passed as bare data so the client component stays free of
  // database imports.
  const standards = STANDARDS.map((s) => ({
    id: s.id,
    label: s.label,
    full: s.full,
    controlCount: s.controls.length,
  }));

  return (
    <div className="mx-auto max-w-[680px] space-y-6">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-xs text-fg-base/60 hover:text-fg-base"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-fg-strong tracking-tight">
          Compliance audit export
        </h1>
        <p className="mt-1 text-sm text-fg-base/60">
          Export the cryptographic receipt chain for SOC 2, PCI DSS 4.0,
          HIPAA Security Rule, or GDPR Article 30 evidence.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-surface px-5 py-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-fg-base">
              Each export is a tamper-evident bundle
            </p>
            <p className="mt-1 text-xs text-fg-base/60">
              We bundle one Ed25519-signed receipt per autonomous fix that
              shipped to production in the selected window. Each receipt is
              independently re-verifiable at{" "}
              <code className="font-mono text-[11px]">
                /api/eap/verify/&lt;receipt_id&gt;
              </code>
              {" "}and via offline Ed25519 verification using the attestor
              public key embedded in <code className="font-mono text-[11px]">manifest.json</code>.
            </p>
          </div>
        </div>
      </section>

      <AuditExportForm
        organizations={orgs.map((o) => ({ id: o.id, name: o.name }))}
        standards={standards}
        plan={userRow?.plan ?? "free"}
      />

      <section className="rounded-xl border border-line bg-surface px-5 py-4">
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-fg-base/60 mb-3">
          Bundle contents
        </h2>
        <ul className="space-y-2 text-sm text-fg-base/80">
          <li>
            <code className="font-mono text-xs text-fg-base/60">manifest.json</code>{" "}
            — workspace, date range, standard mapping, attestor public key,
            verification recipe.
          </li>
          <li>
            <code className="font-mono text-xs text-fg-base/60">summary.pdf</code>{" "}
            — auditor-facing one-pager (US Letter, no JS, no fonts embedded —
            opens in any reader).
          </li>
          <li>
            <code className="font-mono text-xs text-fg-base/60">
              receipts/&lt;id&gt;.json
            </code>{" "}
            — one file per attestation: Merkle root, Ed25519 signature, alert
            metadata, mapped controls.
          </li>
        </ul>
      </section>
    </div>
  );
}
