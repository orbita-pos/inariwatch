/**
 * POST /api/projects/{projectId}/sync-vercel-env
 *
 * Inari Live V1 — Session 3. Writes the project's INARIWATCH_DSN
 * to all three Vercel environments (production / preview / development)
 * so the user's deployed app reports errors to InariWatch with no
 * dashboard hop required.
 *
 * Auth: dual-mode via `authorizeProjectForTokens` — accepts either a
 * NextAuth session (web caller) or a Bearer device token (desktop
 * wizard). Per the locked decision the wizard mints the token, gets
 * back a one-time plaintext, and POSTs it here so the same Inari Live
 * install never has to keep a long-lived Vercel API key.
 *
 * Vercel API contract (api.vercel.com /v9/projects/{id}/env, POST):
 *   * One env var per call. Repeated for production / preview /
 *     development → 3 POSTs total.
 *   * Idempotency: if the var already exists (`code: "ENV_ALREADY_EXISTS"`
 *     in the 400 response) we PATCH it via /v9/projects/{id}/env/{envId}
 *     instead. The wizard re-runs are a normal flow (rotate token,
 *     change DSN host, etc) and overwriting is the intended behavior.
 *   * Team scope: cfg.teamId is read from the encrypted vercel
 *     project_integrations row when set; appended as `?teamId=...`
 *     when present.
 *
 * Why we expose the secret as INARIWATCH_DSN instead of a separate var:
 * the v0.10+ capture SDK already accepts the legacy DSN URL format
 * (`https://<token>@host/capture/<id>`), so writing the DSN keeps the
 * customer's app unchanged while giving us the new S2 token. Bumping
 * the env-var name is reserved for V2 once every shipped capture build
 * understands the new shape natively.
 */

import { NextRequest, NextResponse } from "next/server";

import { authorizeProjectForTokens } from "../tokens/_authorize";
import { db, projectIntegrations } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { logAudit } from "@/lib/audit";
import {
  ProjectStateError,
  getProjectState,
  transitionState,
  type ProjectState,
} from "@/lib/projects/state";

export const runtime = "nodejs";

const VERCEL_API = "https://api.vercel.com";

const TARGETS = ["production", "preview", "development"] as const;
type VercelTarget = (typeof TARGETS)[number];

// ── Types ───────────────────────────────────────────────────────────────────

interface VercelEnvRow {
  id: string;
  key: string;
  target: VercelTarget[];
}

interface SyncRequestBody {
  /** The full DSN-form token. Required — wizard never sends a bare token. */
  dsn?: unknown;
}

interface SyncResultEntry {
  target: VercelTarget;
  status: "created" | "updated" | "error";
  error?: string;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const auth = await authorizeProjectForTokens(projectId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: SyncRequestBody;
  try {
    body = (await req.json()) as SyncRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.dsn !== "string" || body.dsn.length < 32) {
    return NextResponse.json(
      { error: "Missing or invalid 'dsn' field" },
      { status: 400 },
    );
  }
  const dsn = body.dsn.slice(0, 1024); // generous cap; real DSNs are <200 chars

  // Look up the project's vercel integration. Missing = soft 409 so the
  // wizard can render "Connect Vercel first" rather than a hard error.
  const cfg = await readVercelConfig(auth.projectId);
  if (!cfg) {
    return NextResponse.json(
      {
        error: "no_vercel_integration",
        message:
          "This project has no Vercel integration configured. Connect Vercel before syncing the DSN.",
      },
      { status: 409 },
    );
  }

  // Existing-vars probe runs ONCE up front; the per-target loop below
  // can then decide create-vs-update without re-listing.
  let existing: VercelEnvRow[];
  try {
    existing = await listEnvVars(cfg);
  } catch (err) {
    return NextResponse.json(
      { error: "vercel_unreachable", message: String(err) },
      { status: 502 },
    );
  }

  const matchingByTarget = new Map<VercelTarget, VercelEnvRow>();
  for (const row of existing) {
    if (row.key !== "INARIWATCH_DSN") continue;
    for (const t of row.target) matchingByTarget.set(t, row);
  }

  const results: SyncResultEntry[] = [];
  for (const target of TARGETS) {
    const existingRow = matchingByTarget.get(target);
    try {
      if (existingRow) {
        await updateEnvVar(cfg, existingRow.id, dsn, [target]);
        results.push({ target, status: "updated" });
      } else {
        await createEnvVar(cfg, dsn, [target]);
        results.push({ target, status: "created" });
      }
    } catch (err) {
      results.push({
        target,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const errored = results.filter((r) => r.status === "error");

  await logAudit({
    userId:     auth.userId,
    action:     "project.sync_vercel_env",
    resource:   "project",
    resourceId: auth.projectId,
    metadata: {
      results,
      errored: errored.length,
    },
  }).catch(() => undefined);

  // State advance: setting_up → prepared once at least one target succeeded.
  // Wizard treats this as "install complete; ready to run dev". A partial
  // failure (e.g. preview env errored) still flips because the production
  // path is what matters for verification.
  if (results.some((r) => r.status !== "error")) {
    await advanceToPreparedIfEligible(auth.projectId);
  }

  return NextResponse.json(
    {
      ok: errored.length === 0,
      results,
      errored_count: errored.length,
    },
    { status: errored.length === 0 ? 200 : 207 /* Multi-Status */ },
  );
}

// ── Vercel API helpers ──────────────────────────────────────────────────────

interface VercelConfig {
  token:           string;
  vercelProjectId: string;
  teamId?:         string;
}

async function readVercelConfig(projectId: string): Promise<VercelConfig | null> {
  const [row] = await db
    .select({
      configEncrypted: projectIntegrations.configEncrypted,
    })
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.service, "vercel"),
      ),
    )
    .limit(1);
  if (!row) return null;

  const cfg = (row.configEncrypted ?? {}) as Record<string, string>;
  const tokenEnc = cfg.token;
  const vercelProjectId = cfg.projectId;
  if (!tokenEnc || !vercelProjectId) return null;

  let token: string;
  try {
    token = decrypt(tokenEnc);
  } catch {
    return null;
  }

  return {
    token,
    vercelProjectId,
    teamId: cfg.teamId || undefined,
  };
}

function withTeam(cfg: VercelConfig, sep: "?" | "&" = "?"): string {
  return cfg.teamId ? `${sep}teamId=${encodeURIComponent(cfg.teamId)}` : "";
}

async function listEnvVars(cfg: VercelConfig): Promise<VercelEnvRow[]> {
  const url = `${VERCEL_API}/v9/projects/${encodeURIComponent(
    cfg.vercelProjectId,
  )}/env${withTeam(cfg)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) {
    throw new Error(`vercel list env failed (${res.status})`);
  }
  const data = (await res.json()) as { envs?: VercelEnvRow[] };
  return data.envs ?? [];
}

async function createEnvVar(
  cfg: VercelConfig,
  value: string,
  target: VercelTarget[],
): Promise<void> {
  const url = `${VERCEL_API}/v9/projects/${encodeURIComponent(
    cfg.vercelProjectId,
  )}/env${withTeam(cfg)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      key:    "INARIWATCH_DSN",
      value,
      target,
      type:   "encrypted",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`vercel create env failed (${res.status}): ${detail.slice(0, 200)}`);
  }
}

async function updateEnvVar(
  cfg: VercelConfig,
  envId: string,
  value: string,
  target: VercelTarget[],
): Promise<void> {
  const url = `${VERCEL_API}/v9/projects/${encodeURIComponent(
    cfg.vercelProjectId,
  )}/env/${encodeURIComponent(envId)}${withTeam(cfg)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      value,
      target,
      type: "encrypted",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`vercel update env failed (${res.status}): ${detail.slice(0, 200)}`);
  }
}

// ── State helpers ───────────────────────────────────────────────────────────

/**
 * Tries setting_up → prepared. No-op for projects that aren't in
 * setting_up — the route is also called by manual web users wanting
 * to refresh their token, and we don't want to nudge `live` projects
 * back into the wizard funnel.
 */
async function advanceToPreparedIfEligible(projectId: string): Promise<void> {
  const state = await getProjectState(projectId);
  if (state !== "setting_up") return;
  try {
    await transitionState({
      projectId,
      from: "setting_up" as ProjectState,
      to:   "prepared" as ProjectState,
      metadata: { source: "sync_vercel_env" },
    });
  } catch (err) {
    if (err instanceof ProjectStateError && err.code === "stale_from_state") {
      return; // concurrent transition won the race — fine
    }
    throw err;
  }
}
