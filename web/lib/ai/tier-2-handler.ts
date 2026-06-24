/**
 * Fase 7 PR B — Tier 2 handler (multi-agent fan-out)
 *
 * Thin wrapper around `multi-agent-coordinator.ts` that (a) provisions
 * N sub-agent containers from the pool, (b) runs the coordinator, and
 * (c) cleans up after itself. Gated behind `MULTI_AGENT_FANOUT=true`
 * — when off, every call returns `{ ok: false, skipped: "disabled" }`
 * and remediate.ts falls through to the legacy single-agent path.
 *
 * Same result envelope shape as `tier-1-handler.ts` so remediate.ts
 * can treat both handlers uniformly.
 */

import type { RemediationSession } from "@/lib/db/schema";
import type { AIProvider } from "./client";
import type { FileChange } from "./tier-0-handler";
import type { Hypothesis } from "./hypothesis-generator";
import {
  runMultiAgentFanout,
  isFanoutEnabled,
  MAX_SUB_AGENTS,
  type CoordinatorInput,
  type SubAgentSpec,
} from "./multi-agent-coordinator";
import { createContainer, destroyContainer } from "./container-agent";
import crypto from "node:crypto";

/**
 * Canary percentage [0..100]. Only sessions whose deterministic hash
 * (sha256(sessionId) mod 100) falls below this number enter the fan-out
 * path. Default 100 = every eligible session (legacy behavior).
 *
 * Rationale: each fan-out costs ~N× the single-agent pipeline because
 * N sub-agents each run their own ~15-turn loop. Rolling the flag
 * broad blind = 3× cost jump across all Tier 2/3 traffic. A canary
 * lets us collect signal without burning the full multiplier.
 *
 * Rollout plan: start at 20 after the flag is first flipped on. Once
 * FanoutWidget shows success rate >= single-agent baseline for 48h,
 * ramp to 50, then 100. Roll back by setting to 0 — no code change.
 */
export function fanoutCanaryPct(): number {
  const raw = process.env.FANOUT_CANARY_PCT;
  if (raw == null) return 100;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 100;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Deterministic canary gate on a session id. Same input always returns
 * the same bucket, so a given session never flip-flops between the
 * fan-out and the legacy path mid-retry.
 */
export function sessionInCanary(sessionId: string, pct: number): boolean {
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  // 4-byte prefix of sha256 is plenty; mod 100 fairness is well-studied.
  const digest = crypto.createHash("sha256").update(sessionId).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < pct;
}

export type Tier2MultiAgentContext = {
  /** The diagnosis string remediate.ts already built — becomes the
   *  shared base of every sub-agent's prompt. */
  baseErrorContext: string;
  /** Output of `generateHypotheses()`. Minimum 2 required. */
  hypotheses: Hypothesis[];
  apiKey: string;
  provider: AIProvider;
  exploreModel: string;
  fixModel: string;
  /** Hetzner staging URL (same for all sub-agents). */
  stagingUrl: string;
  stagingSecret: string;
  /** GitHub token — required to clone the repo inside each sub-agent
   *  container. Per-request for now; PR #8 container proxy will
   *  source it from the server env when `INARIWATCH_AGENT_PROXY=true`. */
  githubToken: string;
  /** `owner/repo` + branch for the clone URL composition. */
  repoUrl: string;
  branch: string;
  /** SSE emit — coordinator prefixes sub-agent events. */
  emit: (event: string, data: Record<string, unknown>) => void;
};

export type Tier2MultiAgentResult =
  | {
      ok: true;
      explanation: string;
      fileChanges: FileChange[];
      winnerHypothesisId: string;
      subAgentsRun: number;
      turnsOfWinner: number;
      durationMs: number;
    }
  | {
      ok: false;
      skipped:
        | "disabled"
        | "canary_skip"
        | "too_few_hypotheses"
        | "no_staging_server"
        | "container_create_failed"
        | "all_sub_agents_failed"
        | "timeout"
        | "internal_error";
    };

export async function runTier2MultiAgent(
  session: Pick<RemediationSession, "id" | "projectId" | "alertId" | "userId">,
  ctx: Tier2MultiAgentContext,
): Promise<Tier2MultiAgentResult> {
  if (!isFanoutEnabled()) return { ok: false, skipped: "disabled" };
  // Canary gate — skip fan-out on sessions outside the configured
  // percentage. Fires BEFORE container provisioning so we do not pay
  // any infra cost on skipped sessions.
  const canary = fanoutCanaryPct();
  if (!sessionInCanary(session.id, canary)) {
    ctx.emit("fanout_canary_skip", { sessionId: session.id, canaryPct: canary });
    return { ok: false, skipped: "canary_skip" };
  }
  if (ctx.hypotheses.length < 2) return { ok: false, skipped: "too_few_hypotheses" };
  if (!ctx.stagingUrl || !ctx.stagingSecret) {
    return { ok: false, skipped: "no_staging_server" };
  }

  const effective = ctx.hypotheses.slice(0, MAX_SUB_AGENTS);

  // ── Provision N containers IN PARALLEL (batch checkout) ──────────────
  //
  // Earlier versions awaited createContainer sequentially — N × ~100ms
  // round-trip to the staging server. Promise.allSettled fires all N
  // at once; wall time becomes max(RTT) instead of sum(RTT). Savings
  // are biggest on high-N fan-outs: at N=3 we cut ~200ms.
  //
  // If any individual checkout fails, we destroy the ones that did
  // succeed so no container is leaked. Partial success is still
  // reported as `container_create_failed` — we need all N to run the
  // race fairly (a 2-of-3 fan-out isn't the same experiment).
  //
  // A Go-server /pool/checkout?count=N endpoint would further cut the
  // wall time to one RTT. That lives in the inari-staging repo and is
  // a separate follow-up. Client-side parallelism here is ~95% of the
  // savings with zero cross-repo coordination.
  const checkoutResults = await Promise.allSettled(
    effective.map((_, i) =>
      createContainer(
        ctx.stagingUrl,
        ctx.stagingSecret,
        ctx.repoUrl,
        ctx.branch,
        ctx.githubToken,
        `${session.id}-s${i}`,
      )
    )
  );

  const successes: { containerId: string }[] = [];
  const firstError: { error: string } | null = (() => {
    for (const r of checkoutResults) {
      if (r.status === "fulfilled") {
        successes.push({ containerId: r.value });
      }
    }
    const rejected = checkoutResults.find((r) => r.status === "rejected");
    if (!rejected) return null;
    const err = (rejected as PromiseRejectedResult).reason;
    return { error: err instanceof Error ? err.message : String(err) };
  })();

  if (firstError) {
    // Any partial checkout — destroy the ones we grabbed and bail.
    await Promise.all(
      successes.map((c) =>
        destroyContainer(ctx.stagingUrl, ctx.stagingSecret, c.containerId).catch(() => {})
      )
    );
    ctx.emit("fanout_container_create_failed", {
      error: firstError.error,
      acquired: successes.length,
      attempted: effective.length,
    });
    return { ok: false, skipped: "container_create_failed" };
  }

  const created = successes;

  // ── Run the coordinator ────────────────────────────────────────────────
  const subAgents: SubAgentSpec[] = effective.map((h, i) => ({
    hypothesis: h,
    containerId: created[i].containerId,
    containerUrl: ctx.stagingUrl,
    stagingSecret: ctx.stagingSecret,
  }));

  const coordinatorInput: CoordinatorInput = {
    session,
    apiKey: ctx.apiKey,
    provider: ctx.provider,
    exploreModel: ctx.exploreModel,
    fixModel: ctx.fixModel,
    baseErrorContext: ctx.baseErrorContext,
    subAgents,
    emit: ctx.emit,
  };

  const result = await runMultiAgentFanout(coordinatorInput);

  // ── Cleanup — destroy every container, including the winner's ─────────
  //
  // We do NOT keep the winner's container for the downstream gates phase
  // in PR B v1. remediate.ts will re-run the normal single-agent path on
  // the fix files in a fresh container (or the worker's localhost Docker).
  // This keeps the coordinator isolated from the rest of the pipeline.
  await Promise.all(
    created.map((c) =>
      destroyContainer(ctx.stagingUrl, ctx.stagingSecret, c.containerId).catch(() => {})
    )
  );

  if (!result.ok) {
    return {
      ok: false,
      skipped:
        result.skipped === "all_sub_agents_failed" ? "all_sub_agents_failed"
        : result.skipped === "timeout" ? "timeout"
        : result.skipped === "too_few_hypotheses" ? "too_few_hypotheses"
        : "internal_error",
    };
  }

  return {
    ok: true,
    explanation: result.explanation,
    fileChanges: result.files.map((f) => ({ path: f.path, content: f.content })),
    winnerHypothesisId: result.winnerHypothesisId,
    subAgentsRun: effective.length,
    turnsOfWinner: result.turns,
    durationMs: result.durationMs,
  };
}
