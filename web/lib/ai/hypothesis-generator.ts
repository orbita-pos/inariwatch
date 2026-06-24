/**
 * Fase 7 — Hypothesis Generator (PR A, shadow-only)
 *
 * First stage of the multi-agent fan-out pipeline. Given an alert
 * (title + body + diagnosis) and a repo snapshot, returns 3-5 distinct
 * fix hypotheses that downstream sub-agents (PR B) will each investigate
 * in parallel. In this PR, hypothesis generation is SHADOW ONLY — the
 * call runs, the result is logged to `ai_usage_logs`, and the count
 * is persisted to `remediation_sessions.hypothesis_count`, but the
 * actual fix path is unchanged.
 *
 * Arch ref: REMEDIATION_SYSTEM_ARCHITECTURE.md §Fase 7.
 *
 * Model: gpt-5-mini via the existing `callAI` adapter (Responses API
 * under the hood once the Fase 2 migration lands; Chat Completions as
 * fallback). Output is a strict JSON envelope — we parse + validate
 * before returning. Malformed output is a recoverable miss, not a
 * throw — the caller swallows and continues down the legacy path.
 */

import type { RemediationSession } from "@/lib/db/schema";
import { callAI } from "./client";
import { resolveModelForPhase } from "./models";

// ── Public types ───────────────────────────────────────────────────────────

export interface Hypothesis {
  /** Short opaque id produced by the model — just for traceability. */
  id: string;
  /** One-paragraph diagnosis specific to this hypothesis. */
  diagnosis: string;
  /**
   * Optional repo-relative glob limiting the sub-agent's file access.
   * When null, the sub-agent has full repo access. Hypotheses that can
   * name a tight scope are preferred — they make fan-out cheaper.
   */
  scopeGlob: string | null;
  /** Why the model thinks this is a plausible hypothesis. Free text. */
  reasoning: string;
  /** 0-100. Model's own confidence in this hypothesis being right. */
  confidence: number;
}

export type HypothesisGenResult =
  | { ok: true; hypotheses: Hypothesis[]; durationMs: number }
  | { ok: false; skipped: "disabled" | "no_api_key" | "model_error" | "malformed_output" | "empty_output" };

export interface HypothesisInput {
  alertTitle: string;
  alertBody: string;
  diagnosis: string;
  /** Optional compact repo context — file list, recent commits, etc. */
  repoSnapshot?: string;
}

// ── Tunables ───────────────────────────────────────────────────────────────

export const MIN_HYPOTHESES = 2;
export const MAX_HYPOTHESES = 5;
/** Trim each hypothesis body to this many chars to keep logs compact. */
export const HYPOTHESIS_FIELD_LIMIT = 800;

function isEnabled(): boolean {
  const v = process.env.HYPOTHESIS_GEN_ENABLED;
  if (v === undefined) return true;
  return v !== "false" && v !== "0";
}

// ── Prompt ─────────────────────────────────────────────────────────────────

const SYSTEM = `You are the hypothesis generator for an autonomous bug-fixing pipeline.

You receive a production alert + diagnosis and your job is to enumerate
3-5 DISTINCT hypotheses about what the fix likely is. A downstream pool
of specialized sub-agents will each investigate one hypothesis in
parallel. The first sub-agent to produce a verified fix wins; the
others cancel. So your job is to COVER THE HYPOTHESIS SPACE — not to
pick the single best idea.

Hard rules:
- Produce between 3 and 5 hypotheses, distinct in approach or scope.
- Each hypothesis is a plausible, testable theory — not a random guess.
- Prefer hypotheses that can be scoped to a small file glob (e.g.
  "src/auth/**/*.ts"). If a hypothesis needs repo-wide search, set
  scope_glob to null.
- "reasoning" is why a human oncall would take this hypothesis
  seriously. Not marketing.
- "confidence" is 0-100 and MUST sum across hypotheses to between
  80 and 140 (you are allowed to be confident about one and slightly
  overlap with another — but not all 100% or all 10%).
- Diagnoses MUST be distinct. If two hypotheses converge on the same
  root cause, collapse them and add a different angle instead.

Output schema (return ONLY this JSON object, no prose, no fences):

{
  "hypotheses": [
    {
      "id": "<short opaque string>",
      "diagnosis": "<1-3 sentences>",
      "scope_glob": "<repo-relative glob or null>",
      "reasoning": "<why this is plausible, 1-4 sentences>",
      "confidence": <integer 0-100>
    }
  ]
}`;

// ── Entry point ────────────────────────────────────────────────────────────

export async function generateHypotheses(
  session: Pick<RemediationSession, "id" | "projectId" | "alertId" | "userId">,
  input: HypothesisInput,
): Promise<HypothesisGenResult> {
  if (!isEnabled()) return { ok: false, skipped: "disabled" };

  const apiKey = process.env.PLATFORM_AI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, skipped: "no_api_key" };

  const model = resolveModelForPhase("triage", "openai"); // gpt-5-mini
  const userMessage = buildUserMessage(input);

  const start = Date.now();
  let raw: string;
  try {
    raw = await callAI(
      apiKey,
      SYSTEM,
      [{ role: "user", content: userMessage }],
      {
        model,
        provider: "openai",
        maxTokens: 2048,
        timeout: 30_000,
        log: {
          userId: session.userId,
          projectId: session.projectId,
          alertId: session.alertId,
          remediationSessionId: session.id,
          feature: "remediation",
          phase: "hypothesis",
          modelTier: "mini",
          isPlatformKey: true,
        },
      },
    );
  } catch {
    return { ok: false, skipped: "model_error" };
  }

  const parsed = parseEnvelope(raw);
  if (parsed === null) return { ok: false, skipped: "malformed_output" };
  if (parsed.length === 0) return { ok: false, skipped: "empty_output" };

  return { ok: true, hypotheses: parsed, durationMs: Date.now() - start };
}

// ── Building blocks ────────────────────────────────────────────────────────

function buildUserMessage(input: HypothesisInput): string {
  const parts = [
    `Alert title:\n${input.alertTitle}`,
    "",
    `Alert body / stack (truncated):`,
    input.alertBody.slice(0, 6000),
    "",
    `Pre-agent diagnosis:`,
    input.diagnosis.slice(0, 2000),
  ];
  if (input.repoSnapshot) {
    parts.push("", `Repo context (truncated):`, input.repoSnapshot.slice(0, 4000));
  }
  return parts.join("\n");
}

/**
 * Parse the model's JSON envelope. Returns a normalized hypothesis
 * array, or null when the output is unrecoverable. We are generous:
 * markdown fences, leading prose, and surrounding `{...}` noise all
 * get stripped before JSON.parse.
 */
export function parseEnvelope(raw: string): Hypothesis[] | null {
  if (!raw) return null;

  let candidate = raw.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidate = fence[1].trim();
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (objMatch) candidate = objMatch[0];

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const list = obj.hypotheses;
  if (!Array.isArray(list)) return null;

  const normalized: Hypothesis[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    const id = typeof r.id === "string" && r.id.length > 0 ? r.id.slice(0, 64) : null;
    const diagnosis = typeof r.diagnosis === "string" ? r.diagnosis.trim() : "";
    const reasoning = typeof r.reasoning === "string" ? r.reasoning.trim() : "";
    const confidenceRaw = r.confidence;
    const scopeRaw = r.scope_glob;

    if (id === null) continue;
    if (diagnosis.length === 0) continue;
    if (reasoning.length === 0) continue;

    let confidence: number;
    if (typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)) {
      confidence = clamp(Math.round(confidenceRaw), 0, 100);
    } else {
      confidence = 50;
    }

    let scopeGlob: string | null;
    if (typeof scopeRaw === "string" && scopeRaw.trim().length > 0) {
      scopeGlob = scopeRaw.trim().slice(0, 200);
    } else {
      scopeGlob = null;
    }

    normalized.push({
      id,
      diagnosis: diagnosis.slice(0, HYPOTHESIS_FIELD_LIMIT),
      scopeGlob,
      reasoning: reasoning.slice(0, HYPOTHESIS_FIELD_LIMIT),
      confidence,
    });
  }

  if (normalized.length < MIN_HYPOTHESES) return null;
  return normalized.slice(0, MAX_HYPOTHESES);
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
