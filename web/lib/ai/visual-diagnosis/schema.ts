/**
 * Visual diagnosis output schema — what the AI must return.
 *
 * Two complementary exports:
 *   - `visualDiagnosisJsonSchema` — wire shape for Together's structured
 *     outputs (`response_format: { type: "json_schema", json_schema: {...} }`).
 *     Together's grammar-constrained decoding MATHEMATICALLY prevents the
 *     model from emitting fields outside this schema — the strongest
 *     anti-hallucination guarantee we have.
 *   - `VisualDiagnosis` TS type — used by the orchestrator and the
 *     desktop client to parse / render the result.
 *
 * Field design notes (per the diagnosis-precision research synthesis):
 *
 *   - `evidence[]` — every claim must cite verbatim evidence with a `source`
 *     enum. The enum's tight set ("dom", "screenshot", "console", "network",
 *     "state", "repo") prevents fabricated source labels.
 *   - `hypotheses_considered[]` — forces the model to compare 3 alternatives
 *     and explain why it picked the winner. Mitigates "anchor on first
 *     guess" failure mode.
 *   - `unknowns[]` — explicit "I don't know" path. Populated when context
 *     is insufficient. Confidence gate at 75 routes report to "need_info"
 *     status when unknowns is non-empty.
 *   - `confidence` 0..100 — used by the gate. Model is instructed to
 *     calibrate against evidence count + specificity. Qwen's documented
 *     "dissent bias" works in our favour here — the model tends to
 *     under-confidence rather than over-confidence.
 */

// ── Wire schema (JSON Schema for Together's structured outputs) ──────────────

export const visualDiagnosisJsonSchema = {
  name: "visual_diagnosis",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "root_cause",
      "evidence",
      "hypotheses_considered",
      "confidence",
      "unknowns",
      "recommended_fix_hint",
    ],
    properties: {
      root_cause: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "function", "causal_chain"],
        properties: {
          file: {
            type: "string",
            description:
              "Relative repo path of the file containing the bug. " +
              "When unknown, leave as empty string and populate unknowns[].",
          },
          line: {
            type: "integer",
            description:
              "Line number in `file` where the bug originates. 0 when unknown.",
          },
          function: {
            type: "string",
            description:
              "Function or component name. Empty string when unknown.",
          },
          causal_chain: {
            type: "array",
            description:
              "Ordered steps from code defect to runtime state to the " +
              "visual symptom shown in the screenshot. 2-6 steps.",
            items: { type: "string" },
          },
        },
      },
      evidence: {
        type: "array",
        description:
          "Citations that ground EVERY claim in root_cause. Each evidence " +
          "must include a verbatim quote from the source identified by the " +
          "tight `source` enum. Fabricating evidence with a source not in " +
          "the enum is impossible (constrained decoding).",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "type", "source", "quote"],
          properties: {
            claim:  { type: "string" },
            type:   { type: "string" },
            source: {
              type: "string",
              enum: ["dom", "screenshot", "console", "network", "state", "repo", "url", "perf"],
            },
            quote:  { type: "string" },
          },
        },
      },
      hypotheses_considered: {
        type: "array",
        description:
          "Exactly 3 distinct hypotheses about the root cause. The best " +
          "one becomes root_cause; the other two MUST include a " +
          "rejected_because explanation grounded in evidence.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["hypothesis", "score", "rejected_because"],
          properties: {
            hypothesis:       { type: "string" },
            score:            { type: "integer" },
            rejected_because: { type: "string" },
          },
        },
      },
      confidence: {
        type: "integer",
        description:
          "0..100 calibrated against evidence count + specificity. " +
          "Below 60 → 'need_info'. 60-74 → low confidence but show. " +
          "75+ → ship.",
      },
      unknowns: {
        type: "array",
        description:
          "Specific missing artifacts that would raise confidence. Each " +
          "entry should name a concrete piece of context (a file, a state " +
          "value, a network response). Empty array when confidence is high.",
        items: { type: "string" },
      },
      recommended_fix_hint: {
        type: "string",
        description:
          "1-2 sentence direction for the human/AI to make the fix. NOT a " +
          "full patch — just enough context for the remediation pipeline.",
      },
    },
  },
  strict: true,
} as const;

// ── TS type that matches the JSON schema 1:1 ─────────────────────────────────

export type EvidenceSource =
  | "dom"
  | "screenshot"
  | "console"
  | "network"
  | "state"
  | "repo"
  | "url"
  | "perf";

export interface VisualDiagnosisEvidence {
  claim:  string;
  type:   string;
  source: EvidenceSource;
  quote:  string;
}

export interface VisualDiagnosisHypothesis {
  hypothesis:       string;
  score:            number;
  rejected_because: string;
}

export interface VisualDiagnosisRootCause {
  file:         string;
  line:         number;
  function:     string;
  causal_chain: string[];
}

export interface VisualDiagnosis {
  root_cause:            VisualDiagnosisRootCause;
  evidence:              VisualDiagnosisEvidence[];
  hypotheses_considered: VisualDiagnosisHypothesis[];
  confidence:            number;
  unknowns:              string[];
  recommended_fix_hint:  string;
}

// ── Parse + validate ─────────────────────────────────────────────────────────

/**
 * Defensive parser. Together's structured outputs makes schema violations
 * impossible at the API layer, but we re-validate locally so a malformed
 * response (provider 5xx → fallback path, or future schema drift) can't
 * corrupt the visual_reports row.
 *
 * Returns null on any structural mismatch — caller marks the report as
 * `failed` with a clear error.
 */
export function parseVisualDiagnosis(raw: unknown): VisualDiagnosis | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  if (!isObject(r.root_cause)) return null;
  const rc = r.root_cause as Record<string, unknown>;
  if (typeof rc.file !== "string") return null;
  if (typeof rc.line !== "number") return null;
  if (typeof rc.function !== "string") return null;
  if (!Array.isArray(rc.causal_chain) || rc.causal_chain.some((s) => typeof s !== "string")) return null;

  if (!Array.isArray(r.evidence)) return null;
  const evidence: VisualDiagnosisEvidence[] = [];
  for (const e of r.evidence) {
    if (!isObject(e)) return null;
    const ev = e as Record<string, unknown>;
    if (typeof ev.claim !== "string") return null;
    if (typeof ev.type !== "string") return null;
    if (typeof ev.source !== "string" || !isEvidenceSource(ev.source)) return null;
    if (typeof ev.quote !== "string") return null;
    evidence.push({
      claim:  ev.claim,
      type:   ev.type,
      source: ev.source,
      quote:  ev.quote,
    });
  }

  if (!Array.isArray(r.hypotheses_considered)) return null;
  const hypotheses: VisualDiagnosisHypothesis[] = [];
  for (const h of r.hypotheses_considered) {
    if (!isObject(h)) return null;
    const hp = h as Record<string, unknown>;
    if (typeof hp.hypothesis !== "string") return null;
    if (typeof hp.score !== "number") return null;
    if (typeof hp.rejected_because !== "string") return null;
    hypotheses.push({
      hypothesis:       hp.hypothesis,
      score:            hp.score,
      rejected_because: hp.rejected_because,
    });
  }

  if (typeof r.confidence !== "number") return null;
  if (!Array.isArray(r.unknowns) || r.unknowns.some((s) => typeof s !== "string")) return null;
  if (typeof r.recommended_fix_hint !== "string") return null;

  return {
    root_cause: {
      file:         rc.file,
      line:         rc.line,
      function:     rc.function as string,
      causal_chain: rc.causal_chain as string[],
    },
    evidence,
    hypotheses_considered: hypotheses,
    confidence:            r.confidence,
    unknowns:              r.unknowns as string[],
    recommended_fix_hint:  r.recommended_fix_hint,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEvidenceSource(s: string): s is EvidenceSource {
  return ["dom", "screenshot", "console", "network", "state", "repo", "url", "perf"].includes(s);
}
