/**
 * Preview Fix — Tier 3 (AI-predicted HTML) service.
 *
 * Flow:
 *   1. Cache-first lookup by (alert_id, merged_commit_sha). Hits skip Claude.
 *   2. Locate the alert's substrate_recording + extract the last rrweb
 *      FullSnapshot as HTML via `rrweb-html.ts`.
 *   3. Hydrate external stylesheets via `css-hydrate.ts`.
 *   4. Fetch the commit diff via `github-api.getCommitDiff`.
 *   5. Call Claude Sonnet 4.6 with a strict structured-JSON system prompt.
 *   6. Zod-validate the response; on malformed output run one repair retry;
 *      on second failure, fall back to returning the original HTML with
 *      `prediction_status = 'failed'` so the UI still shows *something*.
 *   7. DOMPurify-sanitize `predicted_html` and persist both renders.
 *
 * The service is fire-and-forget from the POST route — any failure is
 * persisted on the preview_sessions row and surfaced to the client via SSE.
 *
 * Cost envelope (per cache miss): Sonnet 4.6 at ~5K in / ~3K out ≈ 6¢. At
 * 1K previews/mo with 70% cache miss = ~$42/mo in Claude cost.
 */

import {
  alerts,
  db,
  previewPredictions,
  previewSessions,
  projectIntegrations,
  remediationSessions,
  substrateRecordings,
  type PreviewPrediction,
} from "@/lib/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { callAI } from "@/lib/ai/client";
import { getPlatformAnthropicKey } from "@/lib/ai/get-key";
import { extractLastSnapshot } from "@/lib/ai/rrweb-html";
import { hydrateExternalStylesheets, mergeStylesheetsIntoHtml } from "@/lib/ai/css-hydrate";
import { getCommitDiff } from "@/lib/services/github-api";
import { decryptConfig } from "@/lib/crypto";

const MODEL = "claude-sonnet-4-6";
const MAX_HTML_BYTES = 400 * 1024;
const MAX_DIFF_BYTES = 150 * 1024;
const AI_TIMEOUT_MS = 30_000;

/** Predicted-HTML shape Claude is required to return. Validated manually —
 *  adding zod for one narrow schema isn't worth the extra dep. */
interface ValidatedPrediction {
  predicted_html: string;
  diff_summary: string;
  confidence: number;
  target_selectors: string[];
}

function validatePrediction(raw: unknown): ValidatedPrediction | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const html = obj.predicted_html;
  if (typeof html !== "string" || html.length < 10 || html.length > 500_000) return null;
  const summaryRaw = obj.diff_summary;
  const summary = typeof summaryRaw === "string" ? summaryRaw.slice(0, 300) : "";
  const confidenceRaw = obj.confidence;
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
      : 50;
  const selectorsRaw = obj.target_selectors;
  const selectors = Array.isArray(selectorsRaw)
    ? selectorsRaw.filter((x): x is string => typeof x === "string").slice(0, 50)
    : [];
  return { predicted_html: html, diff_summary: summary, confidence, target_selectors: selectors };
}

export type Tier3Outcome =
  | { ok: true; prediction: PreviewPrediction; cacheHit: boolean }
  | {
      ok: false;
      reason:
        | "no-substrate-recording"
        | "no-full-snapshot"
        | "no-commit-sha"
        | "no-github-token"
        | "ai-key-unavailable"
        | "ai-call-failed"
        | "malformed-output";
      note?: string;
    };

/**
 * Run the full Tier 3 pipeline for a preview session and persist the result
 * into preview_predictions + the matching preview_sessions columns. Returns
 * the outcome for the caller's metrics; the preview row is authoritative.
 */
export async function kickoffTier3(previewSessionId: string): Promise<Tier3Outcome> {
  const start = Date.now();

  await db
    .update(previewSessions)
    .set({ predictionStatus: "rendering", updatedAt: new Date() })
    .where(eq(previewSessions.id, previewSessionId));

  const [preview] = await db
    .select()
    .from(previewSessions)
    .where(eq(previewSessions.id, previewSessionId))
    .limit(1);
  if (!preview) return { ok: false, reason: "no-substrate-recording", note: "preview row gone" };

  const [remediation] = await db
    .select({
      mergedCommitSha: remediationSessions.mergedCommitSha,
      projectId: remediationSessions.projectId,
      repo: remediationSessions.repo,
    })
    .from(remediationSessions)
    .where(eq(remediationSessions.id, preview.remediationSessionId))
    .limit(1);
  if (!remediation?.mergedCommitSha) {
    return markSkipped(previewSessionId, "no-commit-sha");
  }

  // Cache lookup — same alert + same commit = identical prediction.
  const [cached] = await db
    .select()
    .from(previewPredictions)
    .where(
      and(
        eq(previewPredictions.alertId, preview.alertId),
        eq(previewPredictions.mergedCommitSha, remediation.mergedCommitSha),
      ),
    )
    .limit(1);
  if (cached) {
    await db
      .update(previewSessions)
      .set({
        predictionStatus: "ready",
        predictionId: cached.id,
        predictionDurationMs: Date.now() - start,
        updatedAt: new Date(),
      })
      .where(eq(previewSessions.id, previewSessionId));
    return { ok: true, prediction: cached, cacheHit: true };
  }

  // Locate the substrate recording for this alert.
  const [alertRow] = await db
    .select({ sessionId: alerts.sessionId, projectId: alerts.projectId })
    .from(alerts)
    .where(eq(alerts.id, preview.alertId))
    .limit(1);

  const [recording] = await db
    .select({
      uiEvents: substrateRecordings.uiEvents,
    })
    .from(substrateRecordings)
    .where(
      and(
        alertRow?.sessionId
          ? eq(substrateRecordings.sessionId, alertRow.sessionId)
          : eq(substrateRecordings.alertId, preview.alertId),
        isNotNull(substrateRecordings.uiEvents),
      ),
    )
    .orderBy(desc(substrateRecordings.createdAt))
    .limit(1);

  if (!recording?.uiEvents) {
    return markSkipped(previewSessionId, "no-substrate-recording");
  }

  const snapshot = extractLastSnapshot(recording.uiEvents);
  if (!snapshot) {
    return markSkipped(previewSessionId, "no-full-snapshot");
  }

  // Hydrate external stylesheets (best-effort, non-blocking on failures).
  const hydrated = snapshot.externalStylesheetHrefs.length
    ? await hydrateExternalStylesheets(snapshot.externalStylesheetHrefs)
    : [];
  const originalHtml = mergeStylesheetsIntoHtml(
    snapshot.html,
    snapshot.inlineStylesheets,
    hydrated,
  ).slice(0, MAX_HTML_BYTES);

  // Fetch commit diff for Claude's context.
  const { token, owner } = await loadGithubCreds(remediation.projectId);
  if (!token || !owner) {
    return markFailed(previewSessionId, "no-github-token", "GitHub integration missing token/owner");
  }
  const repoSlug = remediation.repo?.includes("/")
    ? remediation.repo
    : `${owner}/${remediation.repo}`;
  const [repoOwner, repoName] = (repoSlug ?? "").split("/");
  const rawDiff = await getCommitDiff(
    token,
    repoOwner,
    repoName,
    remediation.mergedCommitSha,
    MAX_DIFF_BYTES,
  );
  const diff = rawDiff ?? `(diff unavailable for ${remediation.mergedCommitSha})`;

  const aiKey = getPlatformAnthropicKey();
  if (!aiKey) {
    return markFailed(previewSessionId, "ai-key-unavailable", "PLATFORM_ANTHROPIC_KEY not set");
  }

  let validated: ValidatedPrediction | null = null;
  let rawResponse = "";
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    rawResponse = await callClaudeWithTimeout(
      aiKey.key,
      buildSystemPrompt(),
      buildUserPrompt(originalHtml, diff, preview.alertId),
      AI_TIMEOUT_MS,
    );

    const parsed = tryParsePrediction(rawResponse);
    if (parsed) {
      validated = parsed;
    } else {
      // Repair retry — ask the model to fix its own output.
      const repair = await callClaudeWithTimeout(
        aiKey.key,
        buildSystemPrompt(),
        buildRepairPrompt(rawResponse),
        AI_TIMEOUT_MS,
      );
      validated = tryParsePrediction(repair);
      if (!validated) {
        return markFailed(previewSessionId, "malformed-output", "Claude returned invalid JSON twice");
      }
    }
  } catch (err) {
    const note = err instanceof Error ? err.message.slice(0, 240) : String(err);
    return markFailed(previewSessionId, "ai-call-failed", note);
  }

  const sanitizedPredicted = await sanitizeHtml(validated.predicted_html);

  // Persist cache row.
  const [inserted] = await db
    .insert(previewPredictions)
    .values({
      alertId: preview.alertId,
      mergedCommitSha: remediation.mergedCommitSha,
      predictedHtml: sanitizedPredicted,
      originalHtml,
      diffSummary: validated.diff_summary,
      targetSelectors: validated.target_selectors,
      confidence: validated.confidence,
      tokensIn,
      tokensOut,
      costCents: approxCostCents(tokensIn, tokensOut),
    })
    .returning();

  await db
    .update(previewSessions)
    .set({
      predictionStatus: "ready",
      predictionId: inserted.id,
      predictionDurationMs: Date.now() - start,
      predictionTokensIn: tokensIn,
      predictionTokensOut: tokensOut,
      predictionCents: approxCostCents(tokensIn, tokensOut),
      updatedAt: new Date(),
    })
    .where(eq(previewSessions.id, previewSessionId));

  return { ok: true, prediction: inserted, cacheHit: false };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function markSkipped(
  previewSessionId: string,
  reason: "no-substrate-recording" | "no-full-snapshot" | "no-commit-sha",
): Promise<Tier3Outcome> {
  await db
    .update(previewSessions)
    .set({
      predictionStatus: "skipped",
      predictionError: reason,
      updatedAt: new Date(),
    })
    .where(eq(previewSessions.id, previewSessionId));
  return { ok: false, reason };
}

async function markFailed(
  previewSessionId: string,
  reason: "no-github-token" | "ai-key-unavailable" | "ai-call-failed" | "malformed-output",
  note: string,
): Promise<Tier3Outcome> {
  await db
    .update(previewSessions)
    .set({
      predictionStatus: "failed",
      predictionError: `${reason}: ${note}`.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(previewSessions.id, previewSessionId));
  return { ok: false, reason, note };
}

async function loadGithubCreds(projectId: string): Promise<{ token?: string; owner?: string }> {
  const rows = await db
    .select()
    .from(projectIntegrations)
    .where(eq(projectIntegrations.projectId, projectId));
  const gh = rows.find((r) => r.service === "github");
  if (!gh) return {};
  const config = decryptConfig(gh.configEncrypted) as Record<string, unknown>;
  return {
    token: typeof config.token === "string" ? config.token : undefined,
    owner: typeof config.owner === "string" ? config.owner : undefined,
  };
}

function callClaudeWithTimeout(
  apiKey: string,
  system: string,
  userContent: string,
  timeoutMs: number,
): Promise<string> {
  const promise = callAI(apiKey, system, [{ role: "user", content: userContent }], {
    provider: "claude",
    model: MODEL,
    maxTokens: 8192,
  });
  return Promise.race([
    promise,
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("claude timeout")), timeoutMs),
    ),
  ]);
}

function buildSystemPrompt(): string {
  return `You are a DOM diff predictor for InariWatch's Preview Fix feature.

You receive:
  1. An HTML snapshot of a web page at the moment a bug occurred (originalHtml).
  2. A git unified diff of the autonomous fix that was merged (diff).
  3. A one-line alert message describing the bug (alertTitle).

Your job: return the HTML you EXPECT to see after the fix is deployed.

Rules:
- Only change elements the diff would affect. Do NOT rewrite unrelated markup.
- Preserve every data-* attribute (they're used for replay).
- Do NOT add <script> tags, event handlers (onclick, onload, etc.), or any JS.
- Do NOT add external network requests (no <img src=https://remote>, no <link href=remote>).
- If the diff changes a string literal shown in the UI, update that string.
- If the diff changes a conditional render, flip the relevant element.
- If the fix is server-only (API route, middleware) with no visible DOM change,
  return the original HTML with diff_summary explaining why.
- If you cannot confidently predict, keep the original HTML and explain why
  in diff_summary; set confidence low.

Output STRICT JSON, no prose outside the object, no markdown fences:
{
  "predicted_html": string,
  "diff_summary": string (max 200 chars, what this fix visibly changes),
  "confidence": number (0-100),
  "target_selectors": string[] (CSS selectors of elements you modified)
}`;
}

function buildUserPrompt(html: string, diff: string, alertId: string): string {
  return `### ALERT
(alert_id: ${alertId})

### ORIGINAL HTML (truncated to first ${MAX_HTML_BYTES} bytes if larger)
${html}

### DIFF
${diff}`;
}

function buildRepairPrompt(priorOutput: string): string {
  return `Your previous reply was not valid JSON matching the required schema. Reply again with ONLY the JSON object, no prose, no markdown fences. Previous reply was:

${priorOutput.slice(0, 6000)}`;
}

function tryParsePrediction(raw: string): ValidatedPrediction | null {
  const body = stripFences(raw).trim();
  try {
    const parsed = JSON.parse(body);
    return validatePrediction(parsed);
  } catch {
    return null;
  }
}

function stripFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

async function sanitizeHtml(html: string): Promise<string> {
  // Dynamic import so the build doesn't pull the sanitizer into unrelated
  // module graphs. isomorphic-dompurify works in Node + browser identically.
  const mod = await import("isomorphic-dompurify").catch(() => null);
  if (!mod) {
    // Fallback: strip obviously dangerous constructs. This is a LAST resort —
    // the package should always be present in production.
    return html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/\son\w+="[^"]*"/gi, "")
      .replace(/\son\w+='[^']*'/gi, "")
      .replace(/javascript:/gi, "")
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
  }
  const DOMPurify = mod.default ?? mod;
  return DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "formaction", "action"],
  });
}

/** Sonnet 4.6 pricing: $3/M input, $15/M output. */
function approxCostCents(inputTokens: number, outputTokens: number): number {
  const inputCents = (inputTokens * 3) / 10_000;
  const outputCents = (outputTokens * 15) / 10_000;
  return Math.round(inputCents + outputCents);
}
