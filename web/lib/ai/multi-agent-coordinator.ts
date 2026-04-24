/**
 * Fase 7 PR B — Multi-Agent Coordinator (web-side)
 *
 * Takes the hypothesis list produced by `hypothesis-generator.ts` and
 * spawns one container agent per hypothesis, racing them to first
 * success. The winner's fix envelope is returned; losers are cancelled
 * and their containers destroyed.
 *
 * Design notes (PR B v1 — keep it simple, ship data):
 *   - **Web-side orchestration.** Each sub-agent still invokes the
 *     existing `runContainerAgent()` path, which HTTPs into the Go
 *     staging server on Hetzner. No new worker endpoint.
 *   - **Sequential pool checkouts.** `/pool/checkout` is per-container,
 *     so we acquire N containers back-to-back (~100ms each). For
 *     N<=5 the overhead is ~500ms.
 *   - **AbortController cancellation.** `Promise.race` gives us the
 *     first winner; we fire abort() on the rest, then best-effort
 *     destroy their containers. No Redis pub/sub in v1.
 *   - **Hypothesis scoping is a hint, not a firewall.** The
 *     container agent tools (read_file / write_file / run_command)
 *     do NOT enforce the scope_glob today. The hypothesis text just
 *     directs the model. Hard scope enforcement is a PR B.1 follow-up
 *     once we know whether the soft-scope hint alone is enough.
 *   - **Aggregator fallback.** If every sub-agent exhausts its budget
 *     without producing a fix, we return `{ ok: false, skipped:
 *     "all_sub_agents_failed" }` and let remediate.ts fall through to
 *     the legacy single-agent path. Aggregator single-shot is a PR C
 *     enhancement.
 */

import { runContainerAgent, type ContainerAgentParams, type ContainerAgentResult } from "./container-agent";
import type { AIProvider } from "./client";
import type { Hypothesis } from "./hypothesis-generator";
import type { RemediationSession } from "@/lib/db/schema";

// ── Tunables ───────────────────────────────────────────────────────────────

/** How many sub-agents we allow per fan-out. Bounded by hypothesis
 *  count AND by the pool's willingness to hand out that many containers.
 *  3 is a reasonable first setting: enough diversity, low blast radius. */
export const MAX_SUB_AGENTS = 3;

/** Max wall time for the whole fan-out. Each sub-agent runs ~15 turns
 *  which is ~30-60s. A single stuck sub-agent cannot block the whole
 *  run past this ceiling. */
export const FANOUT_TIMEOUT_MS = 120_000;

// ── Flag ───────────────────────────────────────────────────────────────────

/** Reads env on each call so tests + kamal env push flip without restart. */
export function isFanoutEnabled(): boolean {
  const v = process.env.MULTI_AGENT_FANOUT;
  return v === "true" || v === "1";
}

// ── Public types ───────────────────────────────────────────────────────────

export interface SubAgentSpec {
  hypothesis: Hypothesis;
  /** Caller-owned pool container for this sub-agent. Created and
   *  destroyed by the caller; the coordinator only DRIVES the agent. */
  containerId: string;
  /** Hetzner staging base URL (shared across sub-agents). */
  containerUrl: string;
  /** Staging server bearer token. */
  stagingSecret: string;
}

export interface CoordinatorInput {
  session: Pick<RemediationSession, "id" | "projectId" | "alertId" | "userId">;
  apiKey: string;
  provider: AIProvider;
  exploreModel: string;
  fixModel: string;
  /** The alert + diagnosis string that every sub-agent sees. We prepend
   *  the hypothesis block per sub-agent. */
  baseErrorContext: string;
  /** Per-hypothesis sub-agent specs. Caller prepares containers. */
  subAgents: SubAgentSpec[];
  /** SSE emit function — coordinator re-emits sub-agent events with a
   *  `subAgentId` so the UI can distinguish streams. */
  emit: (event: string, data: Record<string, unknown>) => void;
}

export type CoordinatorResult =
  | {
      ok: true;
      winnerSubAgentId: string;
      winnerHypothesisId: string;
      explanation: string;
      files: ContainerAgentResult["files"];
      turns: number;
      verified: boolean;
      testsPassed: boolean;
      durationMs: number;
      losersCount: number;
    }
  | {
      ok: false;
      skipped:
        | "disabled"
        | "too_few_hypotheses"
        | "all_sub_agents_failed"
        | "timeout"
        | "internal_error";
      attempted: number;
      durationMs: number;
    };

// ── Orchestrator ───────────────────────────────────────────────────────────

export async function runMultiAgentFanout(input: CoordinatorInput): Promise<CoordinatorResult> {
  if (!isFanoutEnabled()) {
    return { ok: false, skipped: "disabled", attempted: 0, durationMs: 0 };
  }

  const start = Date.now();
  const specs = input.subAgents.slice(0, MAX_SUB_AGENTS);
  if (specs.length < 2) {
    return { ok: false, skipped: "too_few_hypotheses", attempted: specs.length, durationMs: Date.now() - start };
  }

  // One abort controller per sub-agent. On winner resolution we fire
  // `controller.abort()` on the losers; their runContainerAgent honors
  // the signal (Fase 7 PR B.1) and throws at the next turn boundary.
  // Losers still complete the turn they are currently inside — we
  // can't interrupt a fetch mid-flight cleanly — but no subsequent
  // turn starts, which caps the wasted work to at most one turn
  // of cost per loser.
  const controllers = specs.map(() => new AbortController());
  let winnerIndex: number | null = null;

  input.emit("fanout_started", {
    subAgentCount: specs.length,
    hypotheses: specs.map((s) => ({ id: s.hypothesis.id, confidence: s.hypothesis.confidence })),
  });

  const subAgentPromises = specs.map((spec, i) => runSubAgent(input, spec, i, controllers[i].signal));
  // Global timeout — never await longer than FANOUT_TIMEOUT_MS.
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("fanout_timeout")), FANOUT_TIMEOUT_MS)
  );

  try {
    const winner = await Promise.race([
      Promise.any(subAgentPromises.map((p, i) =>
        p.then((r) => {
          if (!r.ok) throw new Error("sub_agent_failed");
          // Record the winner index BEFORE we race back — so abort has
          // a stable reference.
          if (winnerIndex == null) winnerIndex = i;
          return { ...r, index: i };
        })
      )),
      timeoutPromise,
    ]);

    // Abort the losers. The container-agent loop will complete whatever
    // turn it's currently on — the signal is a request, not a kill.
    for (let i = 0; i < controllers.length; i++) {
      if (i !== winner.index) controllers[i].abort();
    }

    input.emit("fanout_winner", {
      subAgentId: `s${winner.index}`,
      hypothesisId: specs[winner.index].hypothesis.id,
      turns: winner.turns,
      verified: winner.verified,
    });

    return {
      ok: true,
      winnerSubAgentId: `s${winner.index}`,
      winnerHypothesisId: specs[winner.index].hypothesis.id,
      explanation: winner.explanation,
      files: winner.files,
      turns: winner.turns,
      verified: winner.verified,
      testsPassed: winner.testsPassed,
      durationMs: Date.now() - start,
      losersCount: specs.length - 1,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "fanout_timeout";
    const allFailed = err instanceof AggregateError;
    // AggregateError with all-rejected means every sub-agent errored;
    // plain Error means we hit the global timeout first.
    for (const c of controllers) c.abort();

    input.emit("fanout_failed", {
      reason: isTimeout ? "timeout" : allFailed ? "all_failed" : "internal_error",
    });

    return {
      ok: false,
      skipped: isTimeout ? "timeout" : allFailed ? "all_sub_agents_failed" : "internal_error",
      attempted: specs.length,
      durationMs: Date.now() - start,
    };
  }
}

// ── Sub-agent driver ───────────────────────────────────────────────────────

type SubAgentRunResult =
  | ({ ok: true } & ContainerAgentResult)
  | { ok: false; reason: "verify_failed" | "model_error" };

async function runSubAgent(
  input: CoordinatorInput,
  spec: SubAgentSpec,
  index: number,
  signal: AbortSignal,
): Promise<SubAgentRunResult> {
  const subAgentErrorContext = buildHypothesisErrorContext(spec.hypothesis, input.baseErrorContext);

  const params: ContainerAgentParams = {
    apiKey: input.apiKey,
    provider: input.provider,
    exploreModel: input.exploreModel,
    fixModel: input.fixModel,
    errorContext: subAgentErrorContext,
    containerUrl: spec.containerUrl,
    containerId: spec.containerId,
    stagingSecret: spec.stagingSecret,
    // Fase 7 PR B.1 — thread the per-sub-agent abort signal through.
    // When the coordinator sees a winner, it fires abort() on the
    // losers; their runContainerAgent throws at the next turn boundary.
    signal,
    emit: (event, data) => {
      input.emit(`sub_agent_${event}`, {
        ...data,
        subAgentId: `s${index}`,
        hypothesisId: spec.hypothesis.id,
      });
    },
    log: {
      userId: input.session.userId,
      projectId: input.session.projectId,
      alertId: input.session.alertId,
      remediationSessionId: input.session.id,
      isPlatformKey: true,
    },
  };

  try {
    const result = await runContainerAgent(params);
    // The container agent returns ok=true even when verify failed.
    // For fan-out, we only count a sub-agent as a winner if it
    // verified (tsc/build passed). Losers without verify fall back.
    if (!result.verified) {
      return { ok: false, reason: "verify_failed" };
    }
    return { ok: true, ...result };
  } catch {
    return { ok: false, reason: "model_error" };
  }
}

// ── Hypothesis scope injection ─────────────────────────────────────────────

export function buildHypothesisErrorContext(hypothesis: Hypothesis, base: string): string {
  const scope = hypothesis.scopeGlob
    ? `Scope hint (prefer reads/writes within this glob): ${hypothesis.scopeGlob}`
    : "Scope hint: repo-wide — the fix may live anywhere.";
  return [
    "═══ FOCUSED HYPOTHESIS FOR THIS SUB-AGENT ═══",
    `Hypothesis id: ${hypothesis.id}`,
    `Diagnosis: ${hypothesis.diagnosis}`,
    `Reasoning: ${hypothesis.reasoning}`,
    `Confidence (self-reported): ${hypothesis.confidence}/100`,
    scope,
    "",
    "Investigate ONLY this hypothesis. If the evidence contradicts it",
    "within the first 3 turns, submit a concise note via submit_fix with",
    "an empty patch so the coordinator can rule out this branch quickly.",
    "═══════════════════════════════════════════════",
    "",
    base,
  ].join("\n");
}
