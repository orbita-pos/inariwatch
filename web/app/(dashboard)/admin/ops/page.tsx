import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { authOptions } from "@/lib/auth";
import { DeploysWidget } from "./widgets/deploys";
import { ContainersWidget } from "./widgets/containers";
import { QueuesWidget } from "./widgets/queues";
import { DiskWidget } from "./widgets/disk";
import { CertsWidget } from "./widgets/certs";
import { CronsWidget } from "./widgets/crons";
import { ErrorsWidget } from "./widgets/errors";
import { BansWidget } from "./widgets/bans";
import { EapVerifyWidget } from "./widgets/eap-verify";
import { SubstrateV2Widget } from "./widgets/substrate-v2";

export const metadata: Metadata = { title: "Admin — Ops" };

// Don't cache the page shell — each widget has its own revalidate window.
export const dynamic = "force-dynamic";

function Skeleton({ title, full }: { title: string; full?: boolean }) {
  return (
    <div
      className={`rounded-xl border border-line bg-surface overflow-hidden ${full ? "md:col-span-2" : ""}`}
    >
      <div className="px-5 py-3 border-b border-line">
        <h2 className="text-sm font-semibold text-fg-strong">{title}</h2>
      </div>
      <div className="p-5">
        <div className="h-4 w-3/4 rounded bg-surface-dim animate-pulse" />
        <div className="mt-2 h-4 w-1/2 rounded bg-surface-dim animate-pulse" />
        <div className="mt-2 h-4 w-2/3 rounded bg-surface-dim animate-pulse" />
      </div>
    </div>
  );
}

export default async function OpsPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email || email !== process.env.ADMIN_EMAIL) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-fg-strong">Ops</h1>
        <p className="mt-1 text-sm text-fg-base/60">
          Host, container, queue, cert, cron and alert signals from both Hetzner boxes. Auto-refreshes every 30s.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Suspense fallback={<Skeleton title="Deploys" full />}>
          <DeploysWidget />
        </Suspense>

        <Suspense fallback={<Skeleton title="staging — containers" />}>
          <ContainersWidget box="inari-staging" />
        </Suspense>
        <Suspense fallback={<Skeleton title="web — containers" />}>
          <ContainersWidget box="inari-web" />
        </Suspense>

        <Suspense fallback={<Skeleton title="BullMQ queues" full />}>
          <QueuesWidget />
        </Suspense>

        <Suspense fallback={<Skeleton title="staging — host" />}>
          <DiskWidget box="inari-staging" />
        </Suspense>
        <Suspense fallback={<Skeleton title="web — host" />}>
          <DiskWidget box="inari-web" />
        </Suspense>

        <Suspense fallback={<Skeleton title="staging — TLS certs" />}>
          <CertsWidget box="inari-staging" />
        </Suspense>
        <Suspense fallback={<Skeleton title="web — TLS certs" />}>
          <CertsWidget box="inari-web" />
        </Suspense>

        <Suspense fallback={<Skeleton title="Go cron jobs" full />}>
          <CronsWidget />
        </Suspense>

        <Suspense fallback={<Skeleton title="Own-product alerts" />}>
          <ErrorsWidget />
        </Suspense>

        <Suspense fallback={<Skeleton title="EAP local verify" />}>
          <EapVerifyWidget />
        </Suspense>

        <Suspense fallback={<Skeleton title="Substrate replay v1 vs v2" />}>
          <SubstrateV2Widget />
        </Suspense>

        <Suspense fallback={<Skeleton title="staging — fail2ban" />}>
          <BansWidget box="inari-staging" />
        </Suspense>
        <Suspense fallback={<Skeleton title="web — fail2ban" />}>
          <BansWidget box="inari-web" />
        </Suspense>
      </div>
    </div>
  );
}
