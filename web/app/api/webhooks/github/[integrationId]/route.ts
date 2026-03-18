import { NextResponse } from "next/server";
import {
  verifySignature,
  loadIntegration,
  createAlertIfNew,
  markIntegrationSuccess,
} from "@/lib/webhooks/shared";
import { checkWebhookRateLimit } from "@/lib/webhooks/rate-limit";
import { db, alerts } from "@/lib/db";
import { eq, and, like, sql } from "drizzle-orm";
import { decryptConfig } from "@/lib/crypto";
import { autoAnalyzeAlert } from "@/lib/ai/auto-analyze";
import { assessPRRisk } from "@/lib/ai/risk-assessment";

/**
 * POST /api/webhooks/github/[integrationId]
 *
 * Receives GitHub webhook events and creates alerts in real-time.
 *
 * Supported events:
 * - check_run.completed     → failed CI (critical)
 * - workflow_run.completed   → failed workflow (critical)
 * - pull_request.opened      → info (new PR opened)
 * - pull_request_review      → (unused for now, reserved)
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;

  // Rate limiting
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = checkWebhookRateLimit(ip);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }

  // Load integration
  const integ = await loadIntegration(integrationId);
  if (!integ) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  if (integ.service !== "github") {
    return NextResponse.json({ error: "Not a GitHub integration" }, { status: 400 });
  }

  if (integ.userPlan !== "pro") {
    return NextResponse.json({ error: "Webhooks require a Pro plan." }, { status: 403 });
  }

  // Require webhook secret
  const secret = integ.webhookSecret;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 403 });
  }

  // Read raw body for signature verification
  const body = await req.text();
  if (body.length > 1_000_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // Verify signature — GitHub sends "sha256=<hex>"
  const sigHeader = req.headers.get("x-hub-signature-256") ?? "";
  const sig = sigHeader.replace("sha256=", "");
  if (!sig || !verifySignature(body, sig, secret, "sha256")) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event") ?? "";
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  let created = 0;

  const config = decryptConfig(integ.configEncrypted);
  const alertConfig = (config.alertConfig ?? {}) as Record<string, { enabled?: boolean }>;

  // ── check_run.completed ──────────────────────────────────────────────
  if (event === "check_run" && payload.action === "completed") {
    const checkCi = alertConfig.failed_ci?.enabled !== false;
    if (!checkCi) {
      return NextResponse.json({ ok: true, skipped: "failed_ci disabled" });
    }

    const run = payload.check_run as Record<string, unknown> | undefined;
    if (run?.conclusion === "failure" || run?.conclusion === "timed_out") {
      const repo = payload.repository as Record<string, unknown> | undefined;
      const output = run.output as Record<string, unknown> | undefined;
      const result = await createAlertIfNew(
        {
          severity: "critical",
          title: `CI failing on ${repo?.name ?? "unknown"}/${repo?.default_branch ?? "main"}`,
          body: `Check "${run.name ?? ""}" ${run.conclusion} on commit ${(run.head_sha as string)?.slice(0, 7) ?? "unknown"}.\n\n${output?.summary ?? ""}`.trim(),
          sourceIntegrations: ["github"],
          isRead: false,
          isResolved: false,
        },
        integ.projectId
      );
      if (result) { created++; autoAnalyzeAlert(result).catch(() => {}); }
    }

    // Auto-resolve open "CI failing" alerts when a check run succeeds
    if (run?.conclusion === "success" || run?.conclusion === "neutral") {
      await db
        .update(alerts)
        .set({ isResolved: true })
        .where(
          and(
            eq(alerts.projectId, integ.projectId),
            eq(alerts.isResolved, false),
            like(alerts.title, "%CI failing%"),
            sql`'github' = ANY(${alerts.sourceIntegrations})`
          )
        );
    }
  }

  // ── workflow_run.completed ────────────────────────────────────────────
  if (event === "workflow_run" && payload.action === "completed") {
    const checkCi = alertConfig.failed_ci?.enabled !== false;
    if (!checkCi) {
      return NextResponse.json({ ok: true, skipped: "failed_ci disabled" });
    }

    const run = payload.workflow_run as Record<string, unknown> | undefined;
    if (run?.conclusion === "failure" || run?.conclusion === "timed_out") {
      const repo = payload.repository as Record<string, unknown> | undefined;
      const actor = run.triggering_actor as Record<string, unknown> | undefined;
      const result = await createAlertIfNew(
        {
          severity: "critical",
          title: `Workflow "${run.name ?? ""}" failed on ${repo?.name ?? "unknown"}/${run.head_branch ?? "main"}`,
          body: `Run #${run.run_number ?? "?"} ${run.conclusion}.\nTriggered by ${actor?.login ?? "unknown"} via ${run.event ?? "unknown"}.`,
          sourceIntegrations: ["github"],
          isRead: false,
          isResolved: false,
        },
        integ.projectId
      );
      if (result) { created++; autoAnalyzeAlert(result).catch(() => {}); }
    }
  }

  // ── pull_request ─────────────────────────────────────────────────────
  if (event === "pull_request") {
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    const action = payload.action as string;
    const repo = payload.repository as Record<string, unknown> | undefined;

    // Pre-deploy risk assessment on PR opened/updated
    if ((action === "opened" || action === "synchronize") && pr?.number) {
      const riskEnabled = alertConfig.pr_risk_assessment?.enabled !== false;
      if (riskEnabled) {
        const owner = config.owner as string;
        const repoName = (repo?.name ?? "") as string;
        const prNumber = pr.number as number;

        if (owner && repoName && prNumber) {
          const ghToken = config.token as string;
          // Fire-and-forget: AI risk assessment + comment on PR
          assessPRRisk(integ.projectId, ghToken, owner, repoName, prNumber).catch(() => {});
        }
      }
    }
  }

  await markIntegrationSuccess(integrationId);

  return NextResponse.json({ ok: true, created });
}
