/**
 * Project token routes (Inari Live V1 — Session 2).
 *
 *   POST /api/projects/{projectId}/tokens   → mint a fresh token
 *   GET  /api/projects/{projectId}/tokens   → list (fingerprints only)
 *
 * Plaintext is in the POST response ONLY. Lost = rotate, not recover —
 * see INARI_LIVE_V1_PLAN.md → "Recovery".
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeProjectForTokens } from "./_authorize";
import { mintToken, listTokens } from "@/lib/services/project-tokens.service";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";

const VALID_CREATED_VIA = new Set(["web", "desktop", "cli", "api"] as const);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const auth = await authorizeProjectForTokens(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // Body is optional — empty POST mints a web-created, unlabelled token.
  let body: { device_label?: unknown; created_via?: unknown; scope?: unknown } = {};
  if (req.headers.get("content-length") && Number(req.headers.get("content-length")) > 0) {
    try {
      body = (await req.json()) ?? {};
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const createdViaRaw = typeof body.created_via === "string" ? body.created_via : "web";
  if (!VALID_CREATED_VIA.has(createdViaRaw as typeof VALID_CREATED_VIA extends Set<infer T> ? T : never)) {
    return NextResponse.json({ error: "Invalid created_via" }, { status: 400 });
  }
  const createdVia = createdViaRaw as "web" | "desktop" | "cli" | "api";

  const deviceLabel =
    typeof body.device_label === "string" && body.device_label.length > 0
      ? body.device_label.slice(0, 100)
      : null;

  // V1 lock: events:write only — see "Project token model" decision in plan.
  // Reject anything else now so future scope expansion is a single-line change.
  if (body.scope !== undefined && !isOnlyEventsWriteScope(body.scope)) {
    return NextResponse.json(
      { error: "Only the 'events:write' scope is supported in V1" },
      { status: 400 },
    );
  }

  const result = await mintToken({
    projectId:   auth.projectId,
    workspaceId: auth.workspaceId,
    createdVia,
    createdBy:   auth.userId,
    deviceLabel,
  });

  // Audit logged BEFORE returning so a process kill mid-response doesn't lose
  // the trail. Plaintext is never written to the audit log — only the id
  // and fingerprint, both of which are safe to keep forever.
  await logAudit({
    userId:     auth.userId,
    action:     "project_token.mint",
    resource:   "project_token",
    resourceId: result.id,
    metadata: {
      projectId:   auth.projectId,
      fingerprint: result.fingerprint,
      createdVia,
      deviceLabel: deviceLabel ?? undefined,
    },
  });

  return NextResponse.json(
    {
      id:          result.id,
      token:       result.token,           // PLAINTEXT — shown ONCE
      fingerprint: result.fingerprint,
      dsn:         result.dsn,             // backwards-compat URL
      created_at:  result.createdAt.toISOString(),
      scope:       result.scope,
    },
    { status: 201 },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const auth = await authorizeProjectForTokens(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const tokens = await listTokens(auth.projectId);
  return NextResponse.json({
    tokens: tokens.map((t) => ({
      id:           t.id,
      fingerprint:  t.fingerprint,
      scope:        t.scope,
      created_at:   t.createdAt.toISOString(),
      last_used_at: t.lastUsedAt?.toISOString() ?? null,
      revoked_at:   t.revokedAt?.toISOString() ?? null,
      rotated_to:   t.rotatedTo,
      created_via:  t.createdVia,
      device_label: t.deviceLabel,
    })),
  });
}

function isOnlyEventsWriteScope(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  return value.length === 1 && value[0] === "events:write";
}
