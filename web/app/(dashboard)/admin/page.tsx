import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, notificationQueue, notificationChannels, alerts } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import { retryDeadNotification } from "./actions";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Admin — Dead Letter Queue" };

export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email || email !== process.env.ADMIN_EMAIL) {
    notFound();
  }

  // Fetch last 100 dead notifications, joined with channel and alert for context
  const rows = await db
    .select({
      id: notificationQueue.id,
      alertId: notificationQueue.alertId,
      channelId: notificationQueue.channelId,
      status: notificationQueue.status,
      attempts: notificationQueue.attempts,
      error: notificationQueue.error,
      createdAt: notificationQueue.createdAt,
      nextRetry: notificationQueue.nextRetry,
      channelType: notificationChannels.type,
      channelUserId: notificationChannels.userId,
      alertTitle: alerts.title,
    })
    .from(notificationQueue)
    .leftJoin(notificationChannels, eq(notificationQueue.channelId, notificationChannels.id))
    .leftJoin(alerts, eq(notificationQueue.alertId, alerts.id))
    .where(eq(notificationQueue.status, "dead"))
    .orderBy(desc(notificationQueue.createdAt))
    .limit(100);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-fg-strong">Dead-Letter Queue</h1>
        <p className="mt-1 text-sm text-fg-base/60">
          Notifications that failed after {3} retries. Retry to re-enqueue them.
        </p>
      </div>

      <div className="rounded-xl border border-line bg-surface overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-fg-base/60">
            No dead notifications — all clear.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-black/[0.03] dark:bg-white/[0.03]">
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-fg-base/60">
                    ID
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-fg-base/60">
                    User ID
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-fg-base/60">
                    Channel
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-fg-base/60">
                    Alert
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-fg-base/60">
                    Error
                  </th>
                  <th scope="col" className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-fg-base/60">
                    Attempts
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-fg-base/60">
                    Created
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-fg-base/60">
                    Updated
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-fg-base/60">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3 font-mono text-[11px] text-fg-base/60 max-w-[90px] truncate" title={row.id}>
                      {row.id.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-fg-base/60 max-w-[90px] truncate" title={row.channelUserId ?? ""}>
                      {row.channelUserId ? row.channelUserId.slice(0, 8) + "…" : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full bg-surface-dim px-2 py-0.5 text-xs font-medium text-fg-base">
                        {row.channelType ?? "unknown"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-fg-base max-w-[180px] truncate" title={row.alertTitle ?? row.alertId}>
                      {row.alertTitle ?? row.alertId.slice(0, 8) + "…"}
                    </td>
                    <td className="px-4 py-3 text-fg-base/60 max-w-[200px] truncate text-xs" title={row.error ?? ""}>
                      {row.error ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-center text-fg-base/60">
                      {row.attempts}
                    </td>
                    <td className="px-4 py-3 text-xs text-fg-base/60 whitespace-nowrap">
                      {row.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                    <td className="px-4 py-3 text-xs text-fg-base/60 whitespace-nowrap">
                      {row.nextRetry.toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                    <td className="px-4 py-3">
                      <form
                        action={async () => {
                          "use server";
                          await retryDeadNotification(row.id);
                        }}
                      >
                        <button
                          type="submit"
                          className="rounded-md bg-inari-accent/10 px-3 py-1 text-xs font-medium text-inari-accent hover:bg-inari-accent/20 transition-colors border border-inari-accent/20"
                        >
                          Retry
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
