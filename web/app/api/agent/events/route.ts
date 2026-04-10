import { NextResponse } from "next/server";
import { db, projectIntegrations, projects, users } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { createAlertIfNew } from "@/lib/webhooks/shared";
import { autoAnalyzeAlert } from "@/lib/ai/auto-analyze";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";
import { processAgentBatch } from "@/lib/agent/processor";
import { decrypt } from "@/lib/crypto";
import crypto from "crypto";
import type { AgentBatch } from "@/lib/agent/types";

/**
 * POST /api/agent/events
 *
 * Receives batched events from the InariWatch eBPF Agent.
 * Events are sent as JSON (optionally LZ4 compressed — handled by middleware if needed).
 *
 * Auth: Bearer token (HMAC-SHA256 of agent_id with integration webhook secret)
 *   Header: Authorization: Bearer <token>
 *   Header: X-Agent-Id: <agent_id>
 *   Header: X-Integration-Id: <integration_id>
 *
 * Body (JSON): AgentBatch
 *   - agent_id: string
 *   - hostname: string
 *   - kernel_version: string
 *   - agent_version: string
 *   - batch_id: string
 *   - events: AgentEvent[]
 *   - metrics?: { events_received, events_filtered, events_dropped, uptime_secs, cpu_percent }
 *
 * Max payload: 2MB (agent sends batches of 1000 events / 256KB / 5s)
 */
export async function POST(req: Request) {
  // Rate limiting
  const ip = extractClientIp(req);
  const rateLimit = await checkWebhookRateLimit(ip, 60_000, 300); // 300/min for agent (higher than webhooks)
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }

  // Auth: Bearer token + integration ID
  const authHeader = req.headers.get("authorization") ?? "";
  const integrationId = req.headers.get("x-integration-id") ?? "";
  const agentId = req.headers.get("x-agent-id") ?? "";

  if (!authHeader.startsWith("Bearer ") || !integrationId || !agentId) {
    return NextResponse.json({ error: "Missing auth headers" }, { status: 401 });
  }

  const token = authHeader.slice(7);

  // Validate integration ID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(integrationId)) {
    return NextResponse.json({ error: "Invalid integration ID" }, { status: 400 });
  }

  // Load integration
  const [row] = await db
    .select({
      integ: projectIntegrations,
      userPlan: users.plan,
    })
    .from(projectIntegrations)
    .innerJoin(projects, eq(projectIntegrations.projectId, projects.id))
    .innerJoin(users, eq(projects.userId, users.id))
    .where(
      and(
        eq(projectIntegrations.id, integrationId),
        eq(projectIntegrations.isActive, true)
      )
    )
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  // Only agent integrations can use this endpoint
  if (row.integ.service !== "agent") {
    return NextResponse.json({ error: "Not an agent integration" }, { status: 400 });
  }

  const secret = row.integ.webhookSecret ? decrypt(row.integ.webhookSecret) : null;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 403 });
  }

  // Verify Bearer token: HMAC-SHA256(agent_id, secret)
  const expectedToken = crypto
    .createHmac("sha256", secret)
    .update(agentId)
    .digest("hex");

  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(expectedToken)
    );
    if (!valid) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  // Size limit: 2MB
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > 2_000_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const body = await req.text();
  if (body.length > 2_000_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let batch: AgentBatch;
  try {
    batch = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Basic validation
  if (!batch.events || !Array.isArray(batch.events)) {
    return NextResponse.json({ error: "Missing events array" }, { status: 400 });
  }

  if (batch.agent_id !== agentId) {
    return NextResponse.json({ error: "Agent ID mismatch" }, { status: 400 });
  }

  // Process events — detect threats
  const threats = processAgentBatch(batch);

  // Create alerts for each detected threat
  let alertsCreated = 0;
  const alertIds: string[] = [];

  for (const threat of threats) {
    const alert = await createAlertIfNew(
      {
        severity: threat.severity,
        title: threat.title,
        body: threat.body,
        sourceIntegrations: ["agent"],
        alertType: threat.alertType,
        fingerprint: threat.fingerprint,
        correlationData: threat.correlationData,
        isRead: false,
        isResolved: false,
      },
      row.integ.projectId
    );

    if (alert) {
      alertsCreated++;
      alertIds.push(alert.id);
      // Fire-and-forget auto-analysis
      autoAnalyzeAlert(alert).catch(() => {});
    }
  }

  // Update integration last checked
  await db
    .update(projectIntegrations)
    .set({ lastCheckedAt: new Date(), lastSuccessAt: new Date(), errorCount: 0 })
    .where(eq(projectIntegrations.id, integrationId));

  return NextResponse.json({
    ok: true,
    events_received: batch.events.length,
    threats_detected: threats.length,
    alerts_created: alertsCreated,
    alert_ids: alertIds,
  });
}
