import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, getUserProjectIds } from "@/lib/db";
import { desc, inArray } from "drizzle-orm";

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;

  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) {
    return new Response("No projects found", { status: 404 });
  }

  const allAlerts = await db
    .select()
    .from(alerts)
    .where(inArray(alerts.projectId, projectIds))
    .orderBy(desc(alerts.createdAt))
    .limit(1000);

  // Build CSV
  const headers = [
    "ID",
    "Severity",
    "Title",
    "Body",
    "Source",
    "Status",
    "Read",
    "Created At",
  ];

  const escape = (val: string) => {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const rows = allAlerts.map((a) =>
    [
      a.id,
      a.severity,
      escape(a.title),
      escape((a.body ?? "").slice(0, 500)),
      a.sourceIntegrations.join("; "),
      a.isResolved ? "resolved" : "open",
      a.isRead ? "yes" : "no",
      a.createdAt.toISOString(),
    ].join(",")
  );

  const csv = [headers.join(","), ...rows].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="inari-alerts-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
}
