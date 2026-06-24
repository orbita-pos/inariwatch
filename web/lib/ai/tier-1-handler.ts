/**
 * Tier 1 handler — single-shot gpt-5-nano with category-specialized template.
 *
 * Fast path for "simple, well-categorized" errors (TypeError on a single
 * file with user-code stack frame, missing import). Skips the agentic
 * exploration loop entirely; uses one prompt + one model call.
 *
 * Templates are keyed by `RouterFeatures.errorCategory`. Each template
 * supplies a category-specific system addendum and instructs the model to
 * return the same `{ explanation, files: [{ path, content }] }` envelope
 * the rest of the remediation pipeline expects (so downstream gates,
 * security scan, push, etc. work unchanged).
 *
 * Failures are non-throwing: every miss returns `{ ok: false, skipped }`
 * and remediate.ts falls through to Tier 2.
 */

import type { RemediationSession } from "@/lib/db/schema";
import type { RouterFeatures, ErrorCategory } from "./tier-router";
import type { FileChange } from "./tier-0-handler";
import { callAI } from "./client";
import { resolveModelForPhase } from "./models";

export type Tier1Context = {
  /** Diagnosis text already produced by the first pass of remediate.ts. */
  diagnosis: string;
  /** Files the diagnosis told us to consider, with content read from the
   *  base branch. Same shape remediate.ts uses for the regular fix prompt. */
  fileContents: { path: string; content: string }[];
  /** Original alert title — included in the prompt so the model has the
   *  symptom alongside the diagnosis. */
  alertTitle: string;
  /** Original alert body / stack trace (truncated by caller if huge). */
  alertBody: string;
};

export type Tier1Result =
  | { ok: true; explanation: string; fileChanges: FileChange[] }
  | { ok: false; skipped: "no_template" | "no_api_key" | "model_error" | "malformed_output" | "empty_fix" };

const SYSTEM_BASE = `You are a focused single-shot bug fixer for a production codebase. The user gives you a confirmed diagnosis and the relevant source files. You return a minimal, surgical patch as a JSON object.

Output schema (no other text, no markdown fences):
{"explanation": "<=200 chars why this fix works", "files": [{"path": "<repo-relative path>", "content": "<full new file content>"}]}

Rules:
- Touch only the files needed. Prefer 1 file. Never touch unrelated code.
- "content" is the FULL new file content — not a diff, not a snippet.
- Preserve existing imports, types, formatting, and surrounding code exactly.
- If you cannot fix it confidently in one shot, return {"explanation": "abstain", "files": []}.
- Never invent imports or APIs that aren't in the provided files.`;

const CATEGORY_ADDENDA: Record<ErrorCategory, string | null> = {
  TypeError: `Category: TypeError. Most fixes are an optional-chain (\`a?.b\`), a nullish-coalesce (\`?? fallback\`), or a guard (\`if (!x) return\`). Identify the exact property access that is undefined and add the smallest guard that preserves behavior.`,
  ReferenceError: `Category: ReferenceError. The fix is almost always a missing import or a typo'd identifier. Add the import (matching existing import style — relative vs alias) or correct the identifier. Do not introduce new dependencies.`,
  Runtime: `Category: Runtime (SyntaxError / RangeError / URIError / EvalError). The fix is usually a small expression-level correction. Avoid restructuring code.`,
  Network: null,
  DB: null,
  Auth: null,
  Other: null,
};

export async function runTier1(
  session: Pick<RemediationSession, "id" | "projectId" | "alertId" | "userId">,
  features: RouterFeatures,
  context: Tier1Context,
): Promise<Tier1Result> {
  const addendum = CATEGORY_ADDENDA[features.errorCategory];
  if (!addendum) return { ok: false, skipped: "no_template" };
  if (context.fileContents.length === 0) return { ok: false, skipped: "no_template" };

  const apiKey = process.env.PLATFORM_AI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, skipped: "no_api_key" };

  const model = resolveModelForPhase("fix", "openai");
  const system = `${SYSTEM_BASE}\n\n${addendum}`;
  const userMessage = buildUserMessage(context);

  let raw: string;
  try {
    raw = await callAI(
      apiKey,
      system,
      [{ role: "user", content: userMessage }],
      {
        model,
        provider: "openai",
        maxTokens: 4096,
        timeout: 45_000,
        log: {
          userId: session.userId,
          projectId: session.projectId,
          alertId: session.alertId,
          remediationSessionId: session.id,
          feature: "remediation",
          phase: "fix",
          modelTier: "nano",
          isPlatformKey: true,
        },
      },
    );
  } catch {
    return { ok: false, skipped: "model_error" };
  }

  const parsed = parseFixEnvelope(raw);
  if (!parsed) return { ok: false, skipped: "malformed_output" };
  if (parsed.files.length === 0) return { ok: false, skipped: "empty_fix" };
  return { ok: true, explanation: parsed.explanation, fileChanges: parsed.files };
}

function buildUserMessage(ctx: Tier1Context): string {
  const filesBlock = ctx.fileContents
    .map((f) => `// path: ${f.path}\n${f.content}`)
    .join("\n\n--- next file ---\n\n");
  return [
    `Alert: ${ctx.alertTitle}`,
    "",
    `Stack / body (truncated):`,
    ctx.alertBody.slice(0, 4000),
    "",
    `Confirmed diagnosis:`,
    ctx.diagnosis,
    "",
    `Source files:`,
    filesBlock,
  ].join("\n");
}

function parseFixEnvelope(raw: string): { explanation: string; files: FileChange[] } | null {
  if (!raw) return null;
  let candidate = raw.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidate = fence[1].trim();
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (objMatch) candidate = objMatch[0];
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    const explanation = typeof o.explanation === "string" ? o.explanation : "";
    if (!Array.isArray(o.files)) return null;
    const files: FileChange[] = [];
    for (const item of o.files) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (typeof r.path === "string" && typeof r.content === "string" && r.path.length > 0) {
        files.push({ path: r.path, content: r.content });
      }
    }
    return { explanation: explanation.slice(0, 200), files };
  } catch {
    return null;
  }
}
