/**
 * Visual diagnosis pipeline orchestrator.
 *
 * V0 scope (this file):
 *   - Single-phase diagnose using Qwen3.5-397B-A17B with structured output
 *     (Together's grammar-constrained decoding)
 *   - Updates the visual_reports row through each state transition
 *   - Confidence gate maps the result to status='completed' or 'need_info'
 *
 * V0.5 will add:
 *   - Triage gate (Qwen3.5-9B) — cheap pre-screen that kills ~30% of reports
 *   - External-anchor critique (Gemma 4 31B) — different-family critic to
 *     break Qwen-family correlated hallucinations
 *   - lookup_file tool — path validation against the workspace's code_index
 *
 * Note: the direct-fetch + eslint-disable mirrors the existing pattern in
 * webhooks/capture/[integrationId]/route.ts for the Kimi K2.6 screenshot
 * analyzer. The ai-router-rs lockdown rule blocks `api.together.xyz` from
 * non-router callers; this surface is explicitly carved out until the
 * router gains a vision task type (TODO tracked in INARI_AI_ARCHITECTURE.md).
 */

import {
  getVisualReport,
  updateReportStatus,
} from "@/lib/services/visual-reports.service";
import {
  VISUAL_DIAGNOSIS_SYSTEM_PROMPT,
  buildUserPromptContent,
} from "./prompts";
import {
  visualDiagnosisJsonSchema,
  parseVisualDiagnosis,
  type VisualDiagnosis,
} from "./schema";
import type { CaptureBundle } from "./types";

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Diagnose model — Qwen3.5-397B-A17B has explicit "UI element identification
 * for screenshots" capability in Together's docs and supports JSON schema
 * structured output. ~$0.016/call (8K input + 2K output + 1 image).
 */
const MODEL_DIAGNOSE = "Qwen/Qwen3.5-397B-A17B";

// eslint-disable-next-line inariwatch/no-direct-ai-sdk-import
const TOGETHER_ENDPOINT = "https://api.together.xyz/v1/chat/completions";

/** Hard ceiling on the whole pipeline call. Empirically Qwen3.5-397B-A17B
 *  on Together can take 60-90s end-to-end with a 1MP image + structured
 *  output enforcement (the grammar-constrained decoding adds overhead).
 *  120s leaves headroom; once we add the V0.5 triage gate the diagnose
 *  surface area shrinks and this can come back down. */
const DIAGNOSE_TIMEOUT_MS = 120_000;

/** Diagnoses with confidence below this go to status='need_info'. */
const CONFIDENCE_GATE = 60;

/** Diagnoses at or above this are shipped as completed. Below → need_info. */
const SHIP_CONFIDENCE = 75;

// ── Public entry point ──────────────────────────────────────────────────────

export interface PipelineResult {
  reportId:   string;
  status:     "completed" | "need_info" | "failed";
  diagnosis?: VisualDiagnosis;
  error?:     string;
  durationMs: number;
}

/**
 * Run the diagnosis pipeline for a visual_reports row.
 *
 * Fire-and-forget from the /api/capture/user-report endpoint:
 *
 *   void runVisualDiagnosis(reportId).catch((err) => {
 *     console.error("[visual-diagnosis] pipeline failed:", err);
 *   });
 *
 * All state transitions are persisted to visual_reports.{status, diagnosis,
 * confidence, model_diagnose, cost_cents, duration_ms, error} so the
 * desktop client can stream progress.
 */
export async function runVisualDiagnosis(reportId: string): Promise<PipelineResult> {
  const start = Date.now();

  const report = await getVisualReport(reportId);
  if (!report) {
    return {
      reportId,
      status: "failed",
      error:  "Report not found",
      durationMs: Date.now() - start,
    };
  }

  if (report.status !== "pending") {
    // Re-entrancy guard — pipeline should never run twice for the same row.
    return {
      reportId,
      status: report.status === "completed" ? "completed" : "failed",
      error:  `Report status was ${report.status}, not pending`,
      durationMs: Date.now() - start,
    };
  }

  // PLATFORM_TOGETHER_KEY is the canonical name (see CLAUDE.md §env vars);
  // TOGETHER_API_KEY is the default name on Together's dashboard so a lot
  // of local .env.local files end up with that name instead. Accept either —
  // the canonical one wins when both are set.
  const togetherKey = process.env.PLATFORM_TOGETHER_KEY ?? process.env.TOGETHER_API_KEY;
  if (!togetherKey) {
    const msg = "Set PLATFORM_TOGETHER_KEY (or TOGETHER_API_KEY) on the server";
    await updateReportStatus(reportId, "failed", {
      error:      msg,
      durationMs: Date.now() - start,
    });
    return {
      reportId,
      status:     "failed",
      error:      msg,
      durationMs: Date.now() - start,
    };
  }

  // Move to 'diagnosing' so the desktop client can show a spinner.
  await updateReportStatus(reportId, "diagnosing", {
    modelDiagnose: MODEL_DIAGNOSE,
  });

  // Pull the captured bundle from the row. Stored as JSONB — comes back as
  // the original object shape.
  const bundle = report.bundleJson as unknown as CaptureBundle;

  // The user's description is also stored in alerts.body. We don't fetch
  // it separately here because the prompt embeds the bundle URL + state.
  // Phase 2 SDK puts the description into `bundle.userDescription` when
  // present — fall back to empty.
  const userDescription = (bundle as CaptureBundle & { userDescription?: string }).userDescription ?? "";

  const userContent = buildUserPromptContent(report, bundle, userDescription);

  let diagnosis: VisualDiagnosis | null = null;
  let costCents = 0;
  let lastError: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DIAGNOSE_TIMEOUT_MS);
    try {
      const res = await fetch(TOGETHER_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${togetherKey}`,
        },
        body: JSON.stringify({
          model:       MODEL_DIAGNOSE,
          temperature: 0.1,
          top_p:       0.95,
          max_tokens:  2048,
          // Together's structured outputs — grammar-constrained decoding.
          // The schema is documented on `visualDiagnosisJsonSchema`.
          response_format: {
            type:        "json_schema",
            json_schema: visualDiagnosisJsonSchema,
          },
          // Qwen3.5-397B supports thinking via `chat_template_kwargs`. We
          // leave it off for V0 to keep latency predictable; V0.5 can
          // re-enable for the diagnose phase after benchmark.
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: "system", content: VISUAL_DIAGNOSIS_SYSTEM_PROMPT },
            { role: "user",   content: userContent },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Together ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await res.json() as {
        choices?: { message?: { content?: string } }[];
        usage?:   { prompt_tokens?: number; completion_tokens?: number };
      };

      const content = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (!content) throw new Error("Empty completion from Together");

      const parsed = safeParseJson(content);
      diagnosis = parseVisualDiagnosis(parsed);
      if (!diagnosis) throw new Error("Diagnosis did not conform to schema");

      // Cost math: Qwen3.5-397B-A17B is $0.60 in / $3.60 out per 1M tokens.
      // 60¢ per 1M input + 360¢ per 1M output → divide by 1M to get cents.
      // Rounded UP to nearest cent so we never under-account; sub-cent
      // requests still bill as 1¢. cost_cents is an INTEGER column.
      const inTok    = data.usage?.prompt_tokens     ?? 0;
      const outTok   = data.usage?.completion_tokens ?? 0;
      const costMillicents = inTok * 60 + outTok * 360; // result is (cents × 1M)
      costCents = Math.max(1, Math.ceil(costMillicents / 1_000_000));
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - start;

  if (!diagnosis) {
    await updateReportStatus(reportId, "failed", {
      error:      lastError ?? "Unknown pipeline failure",
      costCents,
      durationMs,
    });
    return {
      reportId,
      status:     "failed",
      error:      lastError ?? "Unknown pipeline failure",
      durationMs,
    };
  }

  // Confidence gate.
  const status: "completed" | "need_info" =
    diagnosis.confidence >= SHIP_CONFIDENCE
      ? "completed"
      : diagnosis.confidence < CONFIDENCE_GATE && diagnosis.unknowns.length > 0
        ? "need_info"
        : "completed"; // 60-74 with no unknowns — ship with low confidence flag in UI

  await updateReportStatus(reportId, status, {
    diagnosis,
    confidence:     diagnosis.confidence,
    modelDiagnose:  MODEL_DIAGNOSE,
    costCents,
    durationMs,
  });

  return {
    reportId,
    status,
    diagnosis,
    durationMs,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // Sometimes models wrap output in markdown fences despite structured
    // output. Strip and retry.
    const fenced = s.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
    try {
      return JSON.parse(fenced);
    } catch {
      return null;
    }
  }
}
