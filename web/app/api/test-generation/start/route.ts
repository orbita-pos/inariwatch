/**
 * POST /api/test-generation/start
 *
 * Entry point for the Inari Guard `/test <path>` flow.
 *
 * Body:
 *   {
 *     projectId:      string  (UUID)
 *     filePath:       string  (relative to repo root)
 *     fileContent:    string  (the actual file content — caller fetches this
 *                              from the user's local clone via the desktop
 *                              app, OR via the GitHub services layer for
 *                              cloud-only mode)
 *     callers?:       Array<{ path, snippet }>
 *     existingTests?: Array<{ path, content }>
 *     frameworkHint?: 'vitest' | 'jest' | 'playwright' | 'mocha' | ...
 *     alertId?:       string  (UUID — when test gen was triggered FROM an
 *                              alert, link the session for analytics)
 *   }
 *
 * Response (200):
 *   {
 *     sessionId: string  (UUID — poll /api/test-generation/[id] for progress)
 *     status:    'ready' | 'failed'
 *     testFile?: { path, content }
 *     plan?:     TestPlan
 *     review?:   TestReviewResult
 *     gates?:    QualityGatesResult
 *     costCents: number
 *     durationMs: number
 *   }
 *
 * Auth: device-token Bearer (V1) OR NextAuth session.
 * Rate-limit: 10 generations per user per hour (Redis-backed).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db, projects, projectIntegrations, alerts, testGenerationSessions, substrateRecordings } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { authenticateExtensionToken } from "@/lib/auth-extension";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { rateLimit } from "@/lib/auth-rate-limit";
import { getProjectOwnerAIKey } from "@/lib/ai/get-key";
import { generateTests } from "@/lib/ai/test-generator";
import { deliverViaPR } from "@/lib/ai/test-delivery";
import { runTestOnWorker } from "@/lib/ai/run-test-on-worker";
import { summariseRecording } from "@/lib/ai/test-from-recording";
import { resolveGitHubAuth } from "@/lib/services/github-token";
import * as gh from "@/lib/services/github-api";

const RATE_LIMIT_MAX = 10;        // per user per hour
const RATE_LIMIT_WINDOW = 3600_000;

const FILE_CONTENT_MAX = 200_000; // 200KB — sane limit for one source file

const BodySchema = z.object({
  projectId: z.string().uuid(),
  /**
   * File source — required UNLESS `recordingId` is set (in which case
   * we synthesise the source from the recording's events server-side).
   */
  filePath: z.string().min(1).max(500).optional(),
  fileContent: z.string().min(1).max(FILE_CONTENT_MAX).optional(),
  /**
   * Substrate-recording source. When set, the cloud fetches the
   * recording, builds a synthetic spec from its events, and feeds
   * that into the three-pass pipeline. The generated test is a
   * regression test for the recorded I/O sequence — the Inari Guard
   * moat (most test-gen tools synthesise from source code; we
   * synthesise from real traces).
   */
  recordingId: z.string().min(1).max(200).optional(),
  callers: z
    .array(z.object({ path: z.string().min(1).max(500), snippet: z.string().max(10_000) }))
    .max(10)
    .optional(),
  existingTests: z
    .array(z.object({ path: z.string().min(1).max(500), content: z.string().max(20_000) }))
    .max(5)
    .optional(),
  frameworkHint: z.string().max(50).optional(),
  alertId: z.string().uuid().optional(),
  /**
   * Delivery mode for the generated test:
   *   inline (default) → return the test content in the response body
   *   pr               → open a draft PR via GitHub. Requires GitHub
   *                      integration on the project. Branch + commit
   *                      pushed to the project's repo.
   *   local            → return inline; the Tauri desktop app writes
   *                      the file to disk using `project_local_path`.
   */
  delivery: z.enum(["inline", "pr", "local"]).optional().default("inline"),
  /**
   * Opt-in: ask the Hetzner worker to clone + install + actually run
   * the generated test before delivery. Adds 60-180s but gives real
   * confidence the test passes against current code. Default off
   * (static gates only) — large repos burn time we'd rather save for
   * common cases.
   */
  verifyOnWorker: z.boolean().optional().default(false),
}).refine(
  (b) => (b.filePath && b.fileContent) || b.recordingId,
  { message: "Either (filePath + fileContent) or recordingId is required" },
);

async function resolveUserId(req: NextRequest): Promise<string | null> {
  const bearer = await authenticateExtensionToken(req);
  if (bearer) return bearer.userId;
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  return userId ?? null;
}

export async function POST(req: NextRequest) {
  // ── Auth ─────────────────────────────────────────────────────────────
  const userId = await resolveUserId(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Rate limit (per-user, generous: 10/hour) ─────────────────────────
  const rl = await rateLimit("test_generation", userId, {
    windowMs: RATE_LIMIT_WINDOW,
    max: RATE_LIMIT_MAX,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded — try again in a few minutes" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) } },
    );
  }

  // ── Parse + validate ─────────────────────────────────────────────────
  let body: z.infer<typeof BodySchema>;
  try {
    const raw = (await req.json()) as unknown;
    body = BodySchema.parse(raw);
  } catch (err) {
    return NextResponse.json(
      {
        error: "Invalid request",
        detail: err instanceof z.ZodError ? err.flatten() : String(err),
      },
      { status: 400 },
    );
  }

  // ── Authorize project access ─────────────────────────────────────────
  const [project] = await db
    .select({ id: projects.id, userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, body.projectId))
    .limit(1);
  if (!project || project.userId !== userId) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // ── Resolve AI key (platform-funded or BYOK) ─────────────────────────
  const aiKey = await getProjectOwnerAIKey(body.projectId);
  if (!aiKey) {
    return NextResponse.json(
      { error: "No AI key available for this project. Connect a key in Settings." },
      { status: 400 },
    );
  }

  // ── Resolve source — either direct file input OR a Substrate recording ─
  // Recording-driven mode synthesises a structured event log the LLM
  // can read like source code. The "moat" feature for Inari Guard:
  // we test what actually ran, not what the LLM hypothesises.
  let effectiveFilePath: string;
  let effectiveFileContent: string;
  let sourceKind: "file" | "recording" = "file";
  let sourceTarget: string;

  if (body.recordingId) {
    const [rec] = await db
      .select({
        recordingId: substrateRecordings.recordingId,
        projectId: substrateRecordings.projectId,
        command: substrateRecordings.command,
        runtime: substrateRecordings.runtime,
        eventCount: substrateRecordings.eventCount,
        durationMs: substrateRecordings.durationMs,
        categories: substrateRecordings.categories,
        events: substrateRecordings.events,
      })
      .from(substrateRecordings)
      .where(eq(substrateRecordings.recordingId, body.recordingId))
      .limit(1);
    if (!rec) {
      return NextResponse.json(
        { error: `Recording not found: ${body.recordingId}` },
        { status: 404 },
      );
    }
    if (rec.projectId && rec.projectId !== body.projectId) {
      // Cross-project recording lookups are forbidden — every recording
      // is project-scoped, so this guarantees test gen can only consume
      // recordings the user already has dashboard access to.
      return NextResponse.json(
        { error: "Recording belongs to a different project" },
        { status: 403 },
      );
    }
    const summary = summariseRecording({
      recordingId: rec.recordingId,
      command: rec.command,
      runtime: rec.runtime,
      eventCount: rec.eventCount,
      durationMs: rec.durationMs,
      categories: rec.categories,
      events: rec.events,
    });
    effectiveFilePath = body.filePath ?? summary.suggestedPath;
    effectiveFileContent = summary.eventsCompact;
    sourceKind = "recording";
    sourceTarget = rec.recordingId;
  } else {
    // Guard already enforced by zod refine, but TS doesn't know that —
    // narrow explicitly.
    if (!body.filePath || !body.fileContent) {
      return NextResponse.json(
        { error: "filePath + fileContent required when recordingId is absent" },
        { status: 400 },
      );
    }
    effectiveFilePath = body.filePath;
    effectiveFileContent = body.fileContent;
    sourceTarget = body.filePath;
  }

  // ── Insert session row (status=pending) ─────────────────────────────
  const [session] = await db
    .insert(testGenerationSessions)
    .values({
      projectId: body.projectId,
      userId,
      sourceKind,
      sourceTarget,
      frameworkHint: body.frameworkHint ?? null,
      status: "exploring",
      steps: [],
      alertId: body.alertId ?? null,
    })
    .returning({ id: testGenerationSessions.id });

  // ── Run the three-pass pipeline (synchronous for MVP — the whole
  // pipeline is ~30-60s, well within Vercel's 300s function budget when
  // routed through this route. Phase 2 will move this to background
  // workers + SSE streaming, mirroring the remediation pipeline).
  const result = await generateTests({
    filePath: effectiveFilePath,
    fileContent: effectiveFileContent,
    callers: body.callers,
    existingTests: body.existingTests,
    frameworkHint: body.frameworkHint,
    apiKey: aiKey.key,
    isPlatformKey: aiKey.isPlatformKey ?? false,
    log: {
      userId,
      projectId: body.projectId,
      alertId: body.alertId,
      sessionId: session.id,
    },
  });

  // ── Optional worker verification (opt-in; ~60-180s extra) ────────────
  // Runs ONLY when the caller asked for it AND WORKER_URL is set. We
  // need the GitHub repo + token to clone; if either is missing we
  // skip verification silently and rely on the static gates.
  let verification: {
    passed: boolean;
    framework: string;
    testsRun: number;
    testsPassed: number;
    testsFailed: number;
    exitCode: number;
    durationMs: number;
    skipped?: string;
    error?: string;
  } | null = null;

  if (body.verifyOnWorker && result.status === "ready" && result.testFile) {
    try {
      // Look up GitHub integration + repo (best-effort; missing → skip).
      const [integration] = await db
        .select()
        .from(projectIntegrations)
        .where(
          and(
            eq(projectIntegrations.projectId, body.projectId),
            eq(projectIntegrations.service, "github"),
            eq(projectIntegrations.isActive, true),
          ),
        )
        .limit(1);
      let repoFull: string | null = null;
      let token: string | null = null;
      if (integration) {
        const auth = await resolveGitHubAuth(integration);
        token = auth.token;
        if (body.alertId) {
          const [a] = await db
            .select({ repo: alerts.repo })
            .from(alerts)
            .where(eq(alerts.id, body.alertId))
            .limit(1);
          if (a?.repo) {
            repoFull = a.repo.includes("/") ? a.repo : `${auth.owner}/${a.repo}`;
          }
        }
      }

      if (!repoFull || !token) {
        verification = {
          passed: false,
          framework: "",
          testsRun: 0,
          testsPassed: 0,
          testsFailed: 0,
          exitCode: -1,
          durationMs: 0,
          skipped: !integration
            ? "no GitHub integration configured for this project"
            : !repoFull
            ? "could not resolve owner/repo — trigger from an alert linked to a repo"
            : "missing GitHub auth token",
        };
      } else {
        const outcome = await runTestOnWorker({
          sessionId: session.id,
          repo: repoFull,
          ref: "HEAD",
          testFiles: [result.testFile],
          githubToken: token,
          // Lean toward the lower end of the worker's range; the cloud
          // route itself has a 300s budget and the worker takes 60-180s.
          timeoutMs: 180_000,
        });
        if (outcome === null) {
          verification = {
            passed: false,
            framework: "",
            testsRun: 0,
            testsPassed: 0,
            testsFailed: 0,
            exitCode: -1,
            durationMs: 0,
            skipped: "WORKER_URL not configured",
          };
        } else if ("failure" in outcome) {
          verification = {
            passed: false,
            framework: "",
            testsRun: 0,
            testsPassed: 0,
            testsFailed: 0,
            exitCode: -1,
            durationMs: 0,
            error: outcome.failure.error,
          };
        } else {
          verification = {
            passed: outcome.passed,
            framework: outcome.framework,
            testsRun: outcome.testsRun,
            testsPassed: outcome.testsPassed,
            testsFailed: outcome.testsFailed,
            exitCode: outcome.exitCode,
            durationMs: outcome.durationMs,
          };
        }
      }
    } catch (err) {
      verification = {
        passed: false,
        framework: "",
        testsRun: 0,
        testsPassed: 0,
        testsFailed: 0,
        exitCode: -1,
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Delivery (mode === 'pr' is the only one that needs follow-up work
  // server-side; 'inline' and 'local' just need the response payload) ──
  let prUrl: string | null = null;
  let prNumber: number | null = null;
  let deliveryError: string | null = null;
  let finalStatus: "ready" | "delivered" | "failed" = result.status === "ready" ? "ready" : "failed";

  if (result.status === "ready" && result.testFile && body.delivery === "pr") {
    try {
      // Pull alert title for the PR subject line when applicable
      let alertTitle: string | undefined;
      if (body.alertId) {
        const [alert] = await db
          .select({ title: alerts.title })
          .from(alerts)
          .where(eq(alerts.id, body.alertId))
          .limit(1);
        alertTitle = alert?.title;
      }

      // Resolve GitHub credentials. resolveGitHubAuth handles the
      // App-install token cache + PAT fallback the same way remediate.ts
      // does — single source of truth.
      const [integration] = await db
        .select()
        .from(projectIntegrations)
        .where(
          and(
            eq(projectIntegrations.projectId, body.projectId),
            eq(projectIntegrations.service, "github"),
            eq(projectIntegrations.isActive, true),
          ),
        )
        .limit(1);
      if (!integration) {
        deliveryError = "No GitHub integration on this project — connect GitHub in /integrations first.";
      } else {
        const { token, owner } = await resolveGitHubAuth(integration);

        // Determine the repo name. Priority: explicit alert.repo > parse
        // from the alert title > project metadata. For pure file-driven
        // generations without an alert, the user MUST have alert.repo
        // somewhere we can derive — otherwise refuse delivery so we
        // don't push to the wrong place.
        let repoName: string | null = null;
        if (body.alertId) {
          const [a] = await db.select({ repo: alerts.repo, title: alerts.title }).from(alerts).where(eq(alerts.id, body.alertId)).limit(1);
          if (a?.repo) {
            // alert.repo can be 'owner/repo' or just 'repo'
            repoName = a.repo.includes("/") ? a.repo.split("/")[1] : a.repo;
          }
        }

        if (!repoName) {
          deliveryError = "Could not determine repo for PR delivery. Trigger this from an alert that's linked to a GitHub repo, or configure project-default repo.";
        } else {
          const defaultBranch = await gh.getDefaultBranch(token, owner, repoName);
          const delivery = await deliverViaPR({
            testFile: result.testFile,
            alertTitle,
            sessionId: session.id,
            token,
            owner,
            repo: repoName,
            defaultBranch,
            alertId: body.alertId,
          });
          prUrl = delivery.prUrl ?? null;
          prNumber = delivery.prNumber ?? null;
          if (prUrl && prNumber) finalStatus = "delivered";
          else if (delivery.error) deliveryError = delivery.error;
        }
      }
    } catch (err) {
      deliveryError = err instanceof Error ? err.message : String(err);
    }
  }

  // ── Persist result ──────────────────────────────────────────────────
  await db
    .update(testGenerationSessions)
    .set({
      status: finalStatus,
      frameworkDetected: result.plan?.framework ?? verification?.framework ?? null,
      testFiles: result.testFile ? [result.testFile] : null,
      testPlan: result.plan ?? null,
      reviewResult: result.review ?? null,
      qualityGates: result.qualityGates ?? null,
      verification,
      modelsUsed: result.modelsUsed,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costCents: result.costCents,
      durationMs: result.durationMs,
      deliveryMode: body.delivery,
      prUrl,
      prNumber,
      error: result.error ?? deliveryError ?? null,
    })
    .where(eq(testGenerationSessions.id, session.id));

  return NextResponse.json({
    sessionId: session.id,
    status: finalStatus,
    testFile: result.testFile,
    plan: result.plan,
    review: result.review,
    gates: result.qualityGates,
    costCents: result.costCents,
    durationMs: result.durationMs,
    prUrl,
    prNumber,
    verification,
    error: result.error ?? deliveryError ?? undefined,
  });
}
