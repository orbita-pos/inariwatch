/**
 * Preview Fix — Tier 1 (live ephemeral Docker deploy) service.
 *
 * Responsibilities:
 *   - Kickoff (detached, never awaited by the request handler):
 *     loads the GitHub token + project env vars, scrubs secrets, calls the
 *     existing `deployStagingEnvironment` with a preview-specific 24h TTL
 *     and writes the returned `live_deploy_id` + `live_url` + `live_status`
 *     on the preview_sessions row.
 *
 *   - Polling + streaming: `pollAndStreamTier1Progress` wraps
 *     `pollStagingStatus` with a 2s cadence and emits state-change events
 *     via the caller-provided `onChunk`. Persists build logs (rolled, last
 *     32KB, secret-scrubbed). Terminates on `running`/`failed` or after a
 *     10min hard cap.
 *
 *   - Teardown: `destroyTier1` calls `destroyStagingEnvironment` and marks
 *     the row `expired`. Invoked by the cron sweep + the explicit
 *     "end preview early" org action.
 *
 * This file deliberately reuses the existing `staging-deploy.ts` client —
 * no Go-server protocol knowledge lives here.
 */

import {
  deployStagingEnvironment,
  destroyStagingEnvironment,
  isStagingConfigured,
  pollStagingStatus,
} from "@/lib/ai/staging-deploy";
import {
  db,
  previewSessions,
  projects,
  projectIntegrations,
  remediationSessions,
} from "@/lib/db";
import { eq } from "drizzle-orm";
import { decryptConfig } from "@/lib/crypto";

/** Secrets we never pass into the preview container's env. */
const SECRET_ENV_PATTERNS: RegExp[] = [
  /_API_KEY$/i,
  /SECRET/i,
  /TOKEN/i,
  /DATABASE_URL/i,
  /STRIPE/i,
  /_PASSWORD$/i,
  /_PRIVATE_KEY$/i,
];

/** Redactor for build-log storage — nobody should see secrets in the UI. */
const SECRET_LOG_REGEXES: RegExp[] = [
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /postgres(?:ql)?:\/\/[^@\s]+@/g,
  /AKIA[A-Z0-9]{16}/g,
];

function redactSecrets(s: string): string {
  let out = s;
  for (const r of SECRET_LOG_REGEXES) out = out.replace(r, "[REDACTED]");
  return out;
}

/**
 * Replace secret-looking env vars with a sentinel. The preview app can
 * detect `NEXT_PUBLIC_INARIWATCH_PREVIEW=1` to render a "Preview mode"
 * banner + disable destructive actions. This is cooperative — security
 * does NOT rely on the app respecting it; the sentinel replacement alone
 * prevents secret leakage into the running container.
 */
function scrubEnv(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_ENV_PATTERNS.some((p) => p.test(k))) {
      out[k] = "PREVIEW_SCRUBBED";
    } else {
      out[k] = v;
    }
  }
  out.NEXT_PUBLIC_INARIWATCH_PREVIEW = "1";
  out.NODE_ENV = out.NODE_ENV ?? "preview";
  return out;
}

/**
 * Start a live preview. Fire-and-forget: the caller should void this
 * promise. Any failure is persisted on the row and surfaced to the client
 * via the SSE stream / GET /api/preview/:id.
 */
export async function kickoffTier1(previewSessionId: string): Promise<void> {
  try {
    if (!isStagingConfigured()) {
      await markFailed(previewSessionId, "Staging server not configured");
      return;
    }

    const [preview] = await db
      .select()
      .from(previewSessions)
      .where(eq(previewSessions.id, previewSessionId))
      .limit(1);
    if (!preview) return;

    const [remediation] = await db
      .select({
        branch: remediationSessions.branch,
        repo: remediationSessions.repo,
        projectId: remediationSessions.projectId,
      })
      .from(remediationSessions)
      .where(eq(remediationSessions.id, preview.remediationSessionId))
      .limit(1);
    if (!remediation || !remediation.branch || !remediation.repo) {
      await markFailed(previewSessionId, "Remediation missing branch or repo");
      return;
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, remediation.projectId))
      .limit(1);
    if (!project) {
      await markFailed(previewSessionId, "Project not found");
      return;
    }

    // GitHub token + owner — same pattern as remediate.ts:364.
    const ghRow = await db
      .select()
      .from(projectIntegrations)
      .where(eq(projectIntegrations.projectId, remediation.projectId))
      .then((rows) => rows.find((r) => r.service === "github"));
    if (!ghRow) {
      await markFailed(previewSessionId, "No GitHub integration for project");
      return;
    }
    const ghConfig = decryptConfig(ghRow.configEncrypted) as Record<string, unknown>;
    const githubToken = ghConfig.token as string | undefined;
    const owner = ghConfig.owner as string | undefined;
    if (!githubToken || !owner) {
      await markFailed(previewSessionId, "GitHub integration missing token/owner");
      return;
    }

    // remediation.repo is stored as either "owner/repo" or just "repo".
    const repoSlug = remediation.repo.includes("/")
      ? remediation.repo
      : `${owner}/${remediation.repo}`;
    const repoUrl = `https://github.com/${repoSlug}.git`;

    // Read project staging env (if configured) and scrub secrets.
    const projectStagingEnv = readProjectStagingEnv(project);
    const envVars = scrubEnv(projectStagingEnv);

    // 24h TTL — long-lived preview URLs are the point. The cron sweep
    // tears them down at `live_expires_at`.
    const ttlSeconds = 24 * 60 * 60;
    const liveExpiresAt = new Date(Date.now() + ttlSeconds * 1000);

    // Start "provisioning" so the client's SSE restore event tells the user
    // something is already happening.
    await db
      .update(previewSessions)
      .set({
        liveStatus: "provisioning",
        liveStartedAt: new Date(),
        liveExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(previewSessions.id, previewSessionId));

    const result = await deployStagingEnvironment({
      deployId: `preview-${preview.id}`,
      repoUrl,
      branch: remediation.branch,
      githubToken,
      framework: "nextjs",
      envVars,
      ttlSeconds,
      projectId: remediation.projectId,
      needsPostgres: false,
      needsRedis: false,
    });

    await db
      .update(previewSessions)
      .set({
        liveStatus: "building",
        liveDeployId: result.id,
        liveUrl: result.url,
        updatedAt: new Date(),
      })
      .where(eq(previewSessions.id, previewSessionId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(previewSessionId, msg.slice(0, 500));
  }
}

/** Project staging-env reader. Returns {} on any error — the preview just
 *  runs with defaults. */
function readProjectStagingEnv(project: {
  stagingEnvEncrypted: unknown;
}): Record<string, string> {
  const encrypted = project.stagingEnvEncrypted;
  if (!encrypted) return {};
  try {
    const decrypted = decryptConfig(encrypted) as Record<string, string>;
    return decrypted ?? {};
  } catch {
    return {};
  }
}

async function markFailed(previewSessionId: string, error: string): Promise<void> {
  await db
    .update(previewSessions)
    .set({
      liveStatus: "failed",
      liveError: error,
      updatedAt: new Date(),
    })
    .where(eq(previewSessions.id, previewSessionId));
}

/**
 * Polling + streaming loop. Caller provides `onEvent` which typically pipes
 * to an SSE response. Safe to abort via AbortSignal — the loop checks after
 * every poll cycle.
 *
 * Events emitted:
 *   - "build_log"  { chunk: string, tsMs: number }
 *   - "live_status" { status, url?, error? }
 *   - "done"       { status: "running" | "failed" | "expired" }
 */
export async function pollAndStreamTier1Progress(
  previewSessionId: string,
  onEvent: (name: string, data: unknown) => void,
  opts: { signal?: AbortSignal; maxMs?: number } = {},
): Promise<void> {
  const maxMs = opts.maxMs ?? 10 * 60_000;
  const deadline = Date.now() + maxMs;

  let [row] = await db
    .select()
    .from(previewSessions)
    .where(eq(previewSessions.id, previewSessionId))
    .limit(1);
  if (!row) return;
  if (!row.liveDeployId) {
    // Not yet provisioned — wait for kickoff to set liveDeployId. Short
    // adaptive wait before first poll.
    await sleep(1500);
    [row] = await db
      .select()
      .from(previewSessions)
      .where(eq(previewSessions.id, previewSessionId))
      .limit(1);
    if (!row?.liveDeployId) {
      onEvent("live_status", { status: row?.liveStatus ?? "pending", error: row?.liveError });
      if (row?.liveStatus === "failed") onEvent("done", { status: "failed" });
      return;
    }
  }

  let lastLogLength = row.liveBuildLogs?.length ?? 0;
  let lastStatus = row.liveStatus;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return;

    try {
      const status = await pollStagingStatus(row.liveDeployId!);
      const normalized = normalizeStatus(status.status);

      // Secret-scrub the logs before surfacing OR storing.
      const newLogs = redactSecrets(status.buildLogs ?? "");
      if (newLogs.length > lastLogLength) {
        const chunk = newLogs.slice(lastLogLength);
        onEvent("build_log", { chunk, tsMs: Date.now() });
        lastLogLength = newLogs.length;

        // Roll at 32KB to keep the column from unbounded growth.
        const rolled = newLogs.length > 32 * 1024 ? newLogs.slice(-32 * 1024) : newLogs;
        await db
          .update(previewSessions)
          .set({ liveBuildLogs: rolled, updatedAt: new Date() })
          .where(eq(previewSessions.id, previewSessionId));
      }

      if (normalized !== lastStatus) {
        const payload: Record<string, unknown> = { status: normalized };
        if (normalized === "running") {
          payload.url = status.url;
          await db
            .update(previewSessions)
            .set({
              liveStatus: "running",
              liveUrl: status.url,
              livePort: status.port,
              liveReadyAt: new Date(),
              buildDurationMs: row.liveStartedAt
                ? Date.now() - row.liveStartedAt.getTime()
                : null,
              updatedAt: new Date(),
            })
            .where(eq(previewSessions.id, previewSessionId));
        } else if (normalized === "failed") {
          payload.error = status.error ?? "build failed";
          await db
            .update(previewSessions)
            .set({
              liveStatus: "failed",
              liveError: status.error?.slice(0, 500) ?? "build failed",
              updatedAt: new Date(),
            })
            .where(eq(previewSessions.id, previewSessionId));
        } else {
          await db
            .update(previewSessions)
            .set({ liveStatus: normalized, updatedAt: new Date() })
            .where(eq(previewSessions.id, previewSessionId));
        }
        onEvent("live_status", payload);
        lastStatus = normalized;
      }

      if (normalized === "running" || normalized === "failed") {
        onEvent("done", { status: normalized });
        return;
      }
    } catch (err) {
      // Transient poll error — don't fail the whole preview; the Go server
      // might be rolling. Emit a warning and retry.
      onEvent("poll_error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    await sleep(2000);
  }

  onEvent("done", { status: "timeout" });
}

function normalizeStatus(raw: string): string {
  // Go server emits: "queued", "deploying", "building", "running", "failed",
  // "expired". Collapse to our preview-row enum.
  switch (raw) {
    case "queued":
    case "deploying":
      return "provisioning";
    case "building":
      return "building";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    default:
      return raw;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cron/admin teardown. Idempotent: calling on an already-expired row is a no-op. */
export async function destroyTier1(previewSessionId: string): Promise<void> {
  const [row] = await db
    .select()
    .from(previewSessions)
    .where(eq(previewSessions.id, previewSessionId))
    .limit(1);
  if (!row || !row.liveDeployId || row.liveStatus === "expired") return;

  try {
    await destroyStagingEnvironment(row.liveDeployId);
  } catch {
    // Best-effort — even if the Go server has already GC'd the container
    // we still want to mark the row as expired on our side.
  }

  await db
    .update(previewSessions)
    .set({ liveStatus: "expired", updatedAt: new Date() })
    .where(eq(previewSessions.id, previewSessionId));
}
