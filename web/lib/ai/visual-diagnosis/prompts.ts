/**
 * Prompts for the visual diagnosis pipeline.
 *
 * Anti-hallucination patterns baked into the system prompt:
 *   1. **Evidence anchoring** — every claim in the output must cite verbatim
 *      evidence from the captured context. The JSON schema enforces a
 *      tight enum on the `source` field so the model can't invent a
 *      source label.
 *   2. **Multi-hypothesis** — model must generate 3 hypotheses, score them,
 *      and explain why the 2 it rejected lost. Forces deliberate
 *      comparison over anchor-first-guess.
 *   3. **"I don't know" path** — explicit instruction + dedicated
 *      `unknowns[]` field. When context is insufficient, model populates
 *      that array instead of fabricating a file path. Qwen's documented
 *      dissent bias amplifies this — the model leans toward omission
 *      over confabulation.
 *   4. **Structured output via constrained decoding** — Together compiles
 *      the JSON schema into a grammar, which mathematically prevents the
 *      model from emitting fields outside the schema. Skipping this is
 *      not optional for Qwen vision models.
 */

import type { VisualReport } from "@/lib/db";
import type { CaptureBundle } from "./types.js";

// ── System prompt ────────────────────────────────────────────────────────────

export const VISUAL_DIAGNOSIS_SYSTEM_PROMPT = `You are InariWatch's visual UI bug diagnostician. Your job is to find the precise root cause of a visual bug the user reported via a screenshot + a captured runtime context bundle.

CRITICAL RULES:

1. EVERY claim in your output must cite verbatim evidence from the captured context, using the \`evidence[]\` array. The \`source\` field is a tight enum — you can't invent a source label.

2. The screenshot is AUTHORITATIVE for what the user sees. The DOM + state + console + network are AUTHORITATIVE for the app's actual runtime state at capture time. If the screenshot disagrees with the captured state, note the discrepancy as a likely hint (it usually means a render-vs-data mismatch).

3. Generate 3 distinct hypotheses about the root cause internally. Score each on (a) explains-screenshot, (b) matches-console/network/state, (c) plausibility given the code-level conventions you can infer. Pick the strongest as \`root_cause\`. Put the other 2 in \`hypotheses_considered[]\` with a \`rejected_because\` grounded in evidence.

4. If you cannot find evidence for a claim, do NOT make the claim. Either request more context (populate \`unknowns[]\` with a specific missing artifact like "contents of useModal.ts" or "fiber state at unmount") or lower your \`confidence\`. Calibrate confidence honestly:
   - 75-100: strong evidence for a single hypothesis, root_cause cited with file:line
   - 60-74:  best-fit hypothesis but missing 1-2 pieces; populate unknowns
   - 0-59:   insufficient evidence; populate unknowns aggressively

5. Do NOT fabricate file paths, line numbers, or function names. If you don't have the repo source in context, leave \`root_cause.file\` empty and put "source code of <component>" in unknowns.

6. \`recommended_fix_hint\` is 1-2 sentences naming WHAT to change and WHY. Not a full patch.

7. \`causal_chain\` is the ordered story from "code defect" → "runtime state" → "visual symptom shown in screenshot". 2-6 steps. Each step references concrete evidence.

8. The user CANNOT see your reasoning — your structured JSON output is the only thing they read. Be specific: file path, line number, function name, and a precise causal chain.

OUTPUT FORMAT: JSON conforming to the visual_diagnosis schema. No prose outside the schema.`;

// ── User prompt builder ──────────────────────────────────────────────────────

export function buildUserPromptContent(
  report: VisualReport,
  bundle: CaptureBundle,
  description: string,
): Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  const lines: string[] = [];

  lines.push(`User description: ${description || "(none provided)"}`);
  lines.push("");
  lines.push(`Page: ${bundle.url}`);
  lines.push(`Viewport: ${bundle.viewport.width}x${bundle.viewport.height} @ ${bundle.viewport.dpr}x`);
  if (bundle.buildId) lines.push(`Build ID: ${bundle.buildId}`);
  lines.push("");

  if (bundle.focused) {
    lines.push("=== ELEMENT UNDER FOCUS ===");
    lines.push(`Selector: ${bundle.focused.selector}`);
    lines.push(`Tag: ${bundle.focused.ax.tag}`);
    if (bundle.focused.ax.role) lines.push(`Role: ${bundle.focused.ax.role}`);
    if (bundle.focused.ax.name) lines.push(`Accessible name: ${bundle.focused.ax.name}`);
    lines.push(`Bounds: ${Math.round(bundle.focused.rect.x)},${Math.round(bundle.focused.rect.y)} ${Math.round(bundle.focused.rect.w)}x${Math.round(bundle.focused.rect.h)}`);
    lines.push("");
    lines.push("Outer HTML (truncated to 2KB):");
    lines.push(bundle.focused.outerHtml);
    lines.push("");
    lines.push("Computed styles (layout/visual subset):");
    for (const [k, v] of Object.entries(bundle.focused.styles)) {
      lines.push(`  ${k}: ${v}`);
    }
    lines.push("");
  }

  if (bundle.console.length) {
    lines.push("=== CONSOLE RING (most recent first, last 15 shown) ===");
    const recent = bundle.console.slice(-15).reverse();
    for (const e of recent) {
      const ago = Math.round((Date.now() - e.ts) / 1000);
      const args = e.args
        .map((a) => (typeof a === "string" ? a : tryStringify(a)))
        .join(" ");
      lines.push(`  [${e.level}] ${ago}s ago: ${truncate(args, 200)}`);
      if (e.site) lines.push(`        at ${e.site}`);
    }
    lines.push("");
  }

  if (bundle.network.length) {
    lines.push("=== NETWORK RING (most recent first, last 10 shown) ===");
    const recent = bundle.network.slice(-10).reverse();
    for (const n of recent) {
      const ago = Math.round((Date.now() - n.ts) / 1000);
      const dur = n.durMs != null ? `${n.durMs}ms` : "?";
      const status = n.status != null ? n.status : "?";
      lines.push(`  [${n.source}] ${n.method} ${truncate(n.url, 100)} → ${status} (${dur}, ${ago}s ago)`);
    }
    lines.push("");
  }

  if (bundle.webVitals) {
    lines.push("=== WEB VITALS ===");
    for (const [k, v] of Object.entries(bundle.webVitals)) {
      lines.push(`  ${k.toUpperCase()}: ${typeof v === "number" ? v.toFixed(2) : v}`);
    }
    lines.push("");
  }

  if (bundle.memory) {
    const mb = (b: number) => `${Math.round(b / 1024 / 1024)}MB`;
    lines.push(`Memory: ${mb(bundle.memory.used)} used / ${mb(bundle.memory.total)} total / ${mb(bundle.memory.limit)} limit`);
    lines.push("");
  }

  lines.push("=== SCREENSHOT ===");
  lines.push("(See attached image — this is what the user saw when they reported the bug.)");

  const text = lines.join("\n");

  return [
    { type: "text", text },
    { type: "image_url", image_url: { url: report.screenshotUrl } },
  ];
}

function tryStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
