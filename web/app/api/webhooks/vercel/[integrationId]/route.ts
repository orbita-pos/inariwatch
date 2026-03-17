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

/**
 * POST /api/webhooks/vercel/[integrationId]
 *
 * Receives Vercel webhook events for deployment failures.
 *
 * Vercel webhook events:
 * - deployment.error     → failed deploy (critical for production, warning for preview)
 * - deployment.canceled  → canceled deploy
 *
 * Vercel signs webhooks with HMAC-SHA1 in the `x-vercel-signature` header.
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

  if (integ.service !== "vercel") {
    return NextResponse.json({ error: "Not a Vercel integration" }, { status: 400 });
  }

  const secret = integ.webhookSecret;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 403 });
  }

  const body = await req.text();
  if (body.length > 1_000_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // Verify signature (Vercel uses HMAC-SHA1)
  const sig = req.headers.get("x-vercel-signature") ?? "";
  if (!sig || !verifySignature(body, sig, secret, "sha1")) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  let created = 0;

  const config = decryptConfig(integ.configEncrypted);
  const alertConfig = (config.alertConfig ?? {}) as Record<string, { enabled?: boolean }>;

  const type = payload.type as string | undefined;

  // ── deployment.error / deployment.canceled ────────────────────────────
  if (type === "deployment.error" || type === "deployment.canceled") {
    const innerPayload = payload.payload as Record<string, unknown> | undefined;
    const dep = (innerPayload?.deployment ?? innerPayload ?? {}) as Record<string, unknown>;
    const projectName = dep.name ?? dep.projectId ?? "unknown";
    const meta = dep.meta as Record<string, unknown> | undefined;
    const target = dep.target ?? meta?.target ?? null;
    const isProduction = target === "production";

    const checkProd = alertConfig.failed_production?.enabled !== false;
    const checkPreview = alertConfig.failed_preview?.enabled === true;

    if ((isProduction && !checkProd) || (!isProduction && !checkPreview)) {
      return NextResponse.json({ ok: true, skipped: "alert type disabled" });
    }

    const state = type === "deployment.error" ? "failed" : "canceled";
    const errorMsg = dep.errorMessage ?? dep.buildError ?? `Build ${state}`;
    const url = dep.url ? `https://${dep.url}` : "";

    const result = await createAlertIfNew(
      {
        severity: isProduction ? "critical" : "warning",
        title: `${isProduction ? "Production" : "Preview"} deploy ${state} — ${projectName}`,
        body: `${errorMsg}${url ? `\n\n${url}` : ""}`,
        sourceIntegrations: ["vercel"],
        isRead: false,
        isResolved: false,
      },
      integ.projectId
    );
    if (result) { created++; autoAnalyzeAlert(result).catch(() => {}); }
  }

  // ── deployment.succeeded → auto-resolve related alerts ────────────────
  if (type === "deployment.succeeded" || type === "deployment.ready") {
    // Auto-resolve any open "deploy failed/canceled" alerts for this project
    // where the source is Vercel.
    await db
      .update(alerts)
      .set({ isResolved: true })
      .where(
        and(
          eq(alerts.projectId, integ.projectId),
          eq(alerts.isResolved, false),
          like(alerts.title, "%deploy%"),
          sql`'vercel' = ANY(${alerts.sourceIntegrations})`
        )
      );
  }

  await markIntegrationSuccess(integrationId);

  return NextResponse.json({ ok: true, created });
}
