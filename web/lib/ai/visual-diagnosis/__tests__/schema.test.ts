/**
 * Tests for parseVisualDiagnosis — the defensive parser that double-checks
 * Together's structured-output response before it lands in the DB. Together's
 * constrained decoding makes most failure modes impossible at the API layer,
 * but we still validate locally so a fallback path (provider 5xx → relaxed
 * JSON parse) can't write malformed data.
 */

import { describe, it, expect } from "vitest";
import { parseVisualDiagnosis, visualDiagnosisJsonSchema } from "../schema";

function validDiagnosis() {
  return {
    root_cause: {
      file:         "web/components/Modal.tsx",
      line:         42,
      function:     "useModal",
      causal_chain: [
        "useEffect cleanup is missing",
        "click-outside listener never detaches",
        "second mount fires both listeners",
        "state toggles twice → modal reopens",
      ],
    },
    evidence: [
      { claim: "useEffect returns undefined", type: "code",     source: "repo",       quote: "return undefined;" },
      { claim: "listener fires twice",        type: "behavior", source: "console",    quote: "click outside fired" },
    ],
    hypotheses_considered: [
      { hypothesis: "missing cleanup",  score: 9, rejected_because: "" },
      { hypothesis: "state race",       score: 5, rejected_because: "no race in console" },
      { hypothesis: "z-index ordering", score: 2, rejected_because: "screenshot shows modal still rendered" },
    ],
    confidence: 84,
    unknowns:   [],
    recommended_fix_hint: "Return the listener-removal function from useEffect.",
  };
}

describe("parseVisualDiagnosis", () => {
  it("accepts a well-formed diagnosis", () => {
    const result = parseVisualDiagnosis(validDiagnosis());
    expect(result).not.toBeNull();
    expect(result!.root_cause.file).toBe("web/components/Modal.tsx");
    expect(result!.confidence).toBe(84);
    expect(result!.evidence).toHaveLength(2);
    expect(result!.hypotheses_considered).toHaveLength(3);
  });

  it("rejects null + non-objects", () => {
    expect(parseVisualDiagnosis(null)).toBeNull();
    expect(parseVisualDiagnosis(undefined)).toBeNull();
    expect(parseVisualDiagnosis("string")).toBeNull();
    expect(parseVisualDiagnosis([1, 2, 3])).toBeNull();
  });

  it("rejects when root_cause.file is missing", () => {
    const d = validDiagnosis();
    delete (d.root_cause as Partial<typeof d.root_cause>).file;
    expect(parseVisualDiagnosis(d)).toBeNull();
  });

  it("rejects when evidence has an invalid source label", () => {
    const d = validDiagnosis();
    d.evidence[0] = { ...d.evidence[0], source: "fabricated-source" };
    expect(parseVisualDiagnosis(d)).toBeNull();
  });

  it("rejects when confidence is not a number", () => {
    const d = validDiagnosis() as unknown as Record<string, unknown>;
    d.confidence = "high";
    expect(parseVisualDiagnosis(d)).toBeNull();
  });

  it("rejects when unknowns array contains non-strings", () => {
    const d = validDiagnosis() as unknown as Record<string, unknown>;
    d.unknowns = [42, "real"];
    expect(parseVisualDiagnosis(d)).toBeNull();
  });

  it("rejects when causal_chain contains non-strings", () => {
    const d = validDiagnosis();
    (d.root_cause.causal_chain as unknown[]) = ["ok", { nope: true }, "fine"];
    expect(parseVisualDiagnosis(d)).toBeNull();
  });

  it("accepts a diagnosis with empty unknowns and empty evidence", () => {
    const d = validDiagnosis();
    d.evidence = [];
    d.unknowns = [];
    const result = parseVisualDiagnosis(d);
    expect(result).not.toBeNull();
    expect(result!.evidence).toEqual([]);
  });

  it("accepts a 'need_info' shaped diagnosis (low confidence + unknowns populated)", () => {
    const d = validDiagnosis();
    d.confidence = 35;
    d.unknowns = ["contents of useModal.ts", "fiber state at unmount"];
    d.root_cause.file = "";
    d.root_cause.line = 0;
    d.root_cause.function = "";
    const result = parseVisualDiagnosis(d);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(35);
    expect(result!.unknowns).toHaveLength(2);
    expect(result!.root_cause.file).toBe("");
  });
});

describe("visualDiagnosisJsonSchema", () => {
  it("declares strict mode and tightens the evidence.source enum", () => {
    expect(visualDiagnosisJsonSchema.strict).toBe(true);
    const sourceProp = (visualDiagnosisJsonSchema.schema.properties.evidence.items.properties.source as { enum: string[] });
    expect(sourceProp.enum).toContain("repo");
    expect(sourceProp.enum).toContain("screenshot");
    expect(sourceProp.enum).not.toContain("fabricated-source");
  });

  it("requires all top-level fields", () => {
    const required = visualDiagnosisJsonSchema.schema.required;
    expect(required).toEqual([
      "root_cause",
      "evidence",
      "hypotheses_considered",
      "confidence",
      "unknowns",
      "recommended_fix_hint",
    ]);
  });

  it("forbids additional properties at every level", () => {
    expect(visualDiagnosisJsonSchema.schema.additionalProperties).toBe(false);
    expect(visualDiagnosisJsonSchema.schema.properties.root_cause.additionalProperties).toBe(false);
    expect(visualDiagnosisJsonSchema.schema.properties.evidence.items.additionalProperties).toBe(false);
    expect(visualDiagnosisJsonSchema.schema.properties.hypotheses_considered.items.additionalProperties).toBe(false);
  });
});
