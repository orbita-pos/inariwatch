import { NextResponse } from "next/server";
import {
  verifySignature,
  loadIntegration,
  createAlertIfNew,
  markIntegrationSuccess,
} from "@/lib/webhooks/shared";
import { checkWebhookRateLimit } from "@/lib/webhooks/rate-limit";
import { decryptConfig } from "@/lib/crypto";
import { autoAnalyzeAlert } from "@/lib/ai/auto-analyze";

/**
 * Fetch the latest event's stack trace for a Sentry issue.
 * Returns a condensed stacktrace string or null.
 */
async function fetchSentryStackTrace(
  token: string,
  org: string,
  issueId: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://sentry.io/api/0/issues/${issueId}/events/latest/`,
      {
        headers: { Authorization: `Bearer ${token}` },
        next: { revalidate: 0 },
      }
    );
    if (!res.ok) return null;

    const event = await res.json();
    const entries = event.entries as { type: string; data: Record<string, unknown> }[] | undefined;
    if (!entries) return null;

    // Find the exception entry
    const exceptionEntry = entries.find((e) => e.type === "exception");
    if (!exceptionEntry) return null;

    const values = (exceptionEntry.data.values ?? []) as {
      type?: string;
      value?: string;
      stacktrace?: {
        frames?: { filename?: string; lineNo?: number; colNo?: number; function?: string; context?: [number, string][] }[];
      };
    }[];

    const parts: string[] = [];
    for (const exc of values) {
      if (exc.type || exc.value) {
        parts.push(`${exc.type ?? "Error"}: ${exc.value ?? ""}`);
      }
      const frames = exc.stacktrace?.frames;
      if (frames && frames.length > 0) {
        // Show last 8 frames (most relevant — closest to the error)
        const relevant = frames.slice(-8);
        for (const f of relevant) {
          const loc = f.lineNo ? `:${f.lineNo}${f.colNo ? `:${f.colNo}` : ""}` : "";
          parts.push(`  at ${f.function ?? "<anonymous>"} (${f.filename ?? "unknown"}${loc})`);
        }
      }
    }

    return parts.length > 0 ? parts.join("\n").slice(0, 2000) : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/webhooks/sentry/[integrationId]
 *
 * Receives Sentry webhook events for new issues and regressions.
 *
 * Sentry webhook headers:
 * - sentry-hook-resource: "issue" | "event" | etc.
 * - sentry-hook-signature: HMAC-SHA256 hex digest
 *
 * Sentry sends:
 * - action: "created" (new issue)
 * - action: "resolved" / "unresolved" (status change)
 * - data.issue contains the issue details
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

  const integ = await loadIntegration(integrationId);
  if (!integ) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  if (integ.service !== "sentry") {
    return NextResponse.json({ error: "Not a Sentry integration" }, { status: 400 });
  }

  const secret = integ.webhookSecret;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 403 });
  }

  const body = await req.text();
  if (body.length > 1_000_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // Verify signature
  const sig = req.headers.get("sentry-hook-signature") ?? "";
  if (!sig || !verifySignature(body, sig, secret, "sha256")) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const resource = req.headers.get("sentry-hook-resource") ?? "";
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  let created = 0;

  const config = decryptConfig(integ.configEncrypted);
  const alertConfig = (config.alertConfig ?? {}) as Record<string, { enabled?: boolean }>;
  const sentryToken = config.token as string | undefined;
  const sentryOrg = (config.org as string) ?? "";

  // ── Issue events ─────────────────────────────────────────────────────
  if (resource === "issue") {
    const action = payload.action as string;
    const data = payload.data as Record<string, unknown> | undefined;
    const issue = (data?.issue ?? {}) as Record<string, unknown>;

    // New issue created
    if (action === "created") {
      const checkNew = alertConfig.new_issues?.enabled !== false;
      if (!checkNew) {
        return NextResponse.json({ ok: true, skipped: "new_issues disabled" });
      }

      const issueId = String(issue.id ?? "");
      const level = (issue.level as string | undefined) ?? "error";
      const permalink = (issue.permalink as string | undefined) ?? "";
      const shortId = (issue.shortId as string | undefined) ?? "";
      const assignedTo = issue.assignedTo as Record<string, unknown> | null | undefined;
      const assignedName = assignedTo ? ((assignedTo.name ?? assignedTo.email ?? assignedTo.username) as string) : "";
      const firstSeen = issue.firstSeen ? new Date(issue.firstSeen as string).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
      const proj = issue.project as Record<string, unknown> | undefined;
      const firstRelease = issue.firstRelease as Record<string, unknown> | undefined;
      const releaseVersion = (firstRelease?.version as string | undefined) ?? "";
      const environment = (issue.environment as string | undefined) ?? "";

      // Map Sentry level to radar severity
      const severity = level === "fatal" ? "critical" : level === "info" ? "info" : "warning";

      // Fetch stack trace for richer error context
      let stackTrace = "";
      if (issueId && sentryToken && sentryOrg) {
        const trace = await fetchSentryStackTrace(sentryToken, sentryOrg, issueId);
        if (trace) stackTrace = `\n\nStack trace:\n${trace}`;
      }

      const bodyParts = [
        issue.culprit ? `In: ${issue.culprit}` : "",
        shortId ? `ID: ${shortId}` : "",
        `${issue.count ?? 0} events · ${issue.userCount ?? 0} user(s) affected`,
        `Project: ${proj?.slug ?? "unknown"}`,
        environment ? `Environment: ${environment}` : "",
        releaseVersion ? `Release: ${releaseVersion}` : "",
        firstSeen ? `First seen: ${firstSeen}` : "",
        assignedName ? `Assigned to: ${assignedName}` : "",
        permalink ? `View in Sentry: ${permalink}` : "",
      ].filter(Boolean).join("\n");

      const result = await createAlertIfNew(
        {
          severity,
          title: `[New Issue] ${issue.title ?? "Unknown error"}`,
          body: (bodyParts + stackTrace).trim(),
          sourceIntegrations: ["sentry"],
          isRead: false,
          isResolved: false,
        },
        integ.projectId
      );
      if (result) { created++; autoAnalyzeAlert(result).catch(() => {}); }
    }

    // Regression (issue was resolved but reappeared)
    if (action === "regression" || (action === "unresolved" && issue.isRegression)) {
      const checkRegression = alertConfig.regressions?.enabled !== false;
      if (!checkRegression) {
        return NextResponse.json({ ok: true, skipped: "regressions disabled" });
      }

      const regressionIssueId = String(issue.id ?? "");
      const regressionLevel = (issue.level as string | undefined) ?? "error";
      const permalink = (issue.permalink as string | undefined) ?? "";
      const shortId = (issue.shortId as string | undefined) ?? "";
      const assignedTo = issue.assignedTo as Record<string, unknown> | null | undefined;
      const assignedName = assignedTo ? ((assignedTo.name ?? assignedTo.email ?? assignedTo.username) as string) : "";
      const firstSeen = issue.firstSeen ? new Date(issue.firstSeen as string).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
      const lastSeen = issue.lastSeen ? new Date(issue.lastSeen as string).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
      const proj = issue.project as Record<string, unknown> | undefined;
      const firstRelease = issue.firstRelease as Record<string, unknown> | undefined;
      const releaseVersion = (firstRelease?.version as string | undefined) ?? "";
      const environment = (issue.environment as string | undefined) ?? "";

      const severity = regressionLevel === "fatal" ? "critical" : "critical"; // regressions always critical

      // Fetch stack trace
      let regressionTrace = "";
      if (regressionIssueId && sentryToken && sentryOrg) {
        const trace = await fetchSentryStackTrace(sentryToken, sentryOrg, regressionIssueId);
        if (trace) regressionTrace = `\n\nStack trace:\n${trace}`;
      }

      const bodyParts = [
        "This issue was previously resolved but has reappeared.",
        issue.culprit ? `In: ${issue.culprit}` : "",
        shortId ? `ID: ${shortId}` : "",
        `${issue.count ?? 0} events · ${issue.userCount ?? 0} user(s) affected`,
        `Project: ${proj?.slug ?? "unknown"}`,
        environment ? `Environment: ${environment}` : "",
        releaseVersion ? `Release: ${releaseVersion}` : "",
        firstSeen ? `First seen: ${firstSeen}` : "",
        lastSeen ? `Last seen: ${lastSeen}` : "",
        assignedName ? `Assigned to: ${assignedName}` : "",
        permalink ? `View in Sentry: ${permalink}` : "",
      ].filter(Boolean).join("\n");

      const result = await createAlertIfNew(
        {
          severity,
          title: `[Regression] ${issue.title ?? "Unknown error"}`,
          body: (bodyParts + regressionTrace).trim(),
          sourceIntegrations: ["sentry"],
          isRead: false,
          isResolved: false,
        },
        integ.projectId
      );
      if (result) { created++; autoAnalyzeAlert(result).catch(() => {}); }
    }
  }

  // ── Event-level alerts (Sentry alert rules) ──────────────────────────
  if (resource === "event_alert") {
    const eventData = payload.data as Record<string, unknown> | undefined;
    const ev = (eventData?.event ?? {}) as Record<string, unknown>;

    const level = (ev.level as string | undefined) ?? "error";
    const severity = level === "fatal" ? "critical" : "warning";
    const environment = (ev.environment as string | undefined) ?? "";
    const release = (ev.release as string | undefined) ?? "";
    const eventUrl = (ev.url as string | undefined) ?? "";
    const triggeredRule = (eventData?.triggered_rule as string | undefined) ?? "";

    const bodyParts = [
      (ev.culprit ?? ev.message ?? "A Sentry alert rule was triggered.") as string,
      triggeredRule ? `Rule: ${triggeredRule}` : "",
      environment ? `Environment: ${environment}` : "",
      release ? `Release: ${release}` : "",
      eventUrl ? `Event URL: ${eventUrl}` : "",
    ].filter(Boolean).join("\n");

    const result = await createAlertIfNew(
      {
        severity,
        title: `[Sentry Alert] ${ev.title ?? triggeredRule ?? "Alert triggered"}`,
        body: bodyParts,
        sourceIntegrations: ["sentry"],
        isRead: false,
        isResolved: false,
      },
      integ.projectId
    );
    if (result) { created++; autoAnalyzeAlert(result).catch(() => {}); }
  }

  await markIntegrationSuccess(integrationId);

  return NextResponse.json({ ok: true, created });
}
