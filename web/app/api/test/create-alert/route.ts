import { NextResponse } from "next/server";
import { db, projects, alerts } from "@/lib/db";
import { enqueueAlert } from "@/lib/notifications/send";
import type { Alert } from "@/lib/db";

const SAMPLE_ALERTS = [
  {
    severity: "critical" as const,
    title: "CI failed on main — build #147",
    body: "Error: Module not found: Can't resolve '@/lib/auth'\n\nStep 'npm run build' failed with exit code 1.\nTriggered by push to main by @jesusrafael.",
    sourceIntegrations: ["github"],
  },
  {
    severity: "warning" as const,
    title: "PR #42 unreviewed for 36 hours",
    body: "Pull request 'feat: add notification queue system' has been open for 36 hours with no reviews.\n\nAuthor: @jesusrafael\nBranch: feat/notification-queue → main\nFiles changed: 12",
    sourceIntegrations: ["github"],
  },
  {
    severity: "critical" as const,
    title: "Production deploy failed — inariwatch.com",
    body: "Deployment dpl_8xK2mNvR failed for project useinari-app.\n\nError: Build exceeded maximum duration (60s).\nCommit: fix: update drizzle schema\nBranch: main",
    sourceIntegrations: ["vercel"],
  },
  {
    severity: "warning" as const,
    title: "PR #38 is stale — no activity for 5 days",
    body: "Pull request 'refactor: migrate to server actions' has had no activity for 5 days.\n\nAuthor: @jesusrafael\nLast updated: 5 days ago\nStatus: 2 review comments unresolved",
    sourceIntegrations: ["github"],
  },
  {
    severity: "info" as const,
    title: "Preview deploy failed — feat/email-notifications",
    body: "Deployment dpl_3yP9qWvX failed for branch feat/email-notifications.\n\nError: Type error in lib/notifications/send.ts:45\nThis is a preview deployment and may not affect production.",
    sourceIntegrations: ["vercel"],
  },
];

/**
 * GET /api/test/create-alert?count=3
 *
 * Creates sample alerts for testing. Only works in development.
 */
export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 403 });
  }

  // Grab the first project in the DB
  const [project] = await db.select().from(projects).limit(1);

  if (!project) {
    return NextResponse.json({ error: "No projects found. Create a project first." }, { status: 400 });
  }

  const url = new URL(req.url);
  const count = Math.min(Math.max(parseInt(url.searchParams.get("count") ?? "3"), 1), 5);

  const created: Alert[] = [];

  for (let i = 0; i < count; i++) {
    const sample = SAMPLE_ALERTS[i % SAMPLE_ALERTS.length];

    const [inserted] = await db
      .insert(alerts)
      .values({
        projectId: project.id,
        severity: sample.severity,
        title: sample.title,
        body: sample.body,
        sourceIntegrations: sample.sourceIntegrations,
      })
      .returning();

    created.push(inserted as Alert);

    try {
      await enqueueAlert(inserted as Alert);
    } catch {
      // Non-blocking
    }
  }

  return NextResponse.json({
    ok: true,
    created: created.length,
    project: project.name,
    alerts: created.map((a) => ({
      id: a.id,
      severity: a.severity,
      title: a.title,
    })),
  });
}
