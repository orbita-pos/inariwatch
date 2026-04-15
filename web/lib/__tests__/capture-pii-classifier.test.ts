/**
 * Tests for the PII heuristic classifier that ships in @inariwatch/capture-replay.
 *
 * The capture-replay SDK doesn't bundle a test runner, so the tests live in
 * web/ (which has vitest). The classifier has no imports of its own so
 * direct relative-path loading is safe.
 */

import { describe, it, expect } from "vitest";
import {
  classifyField,
  shouldMask,
  isUncertain,
  hashFeatures,
  MASK_THRESHOLD,
  UNCERTAIN_THRESHOLD,
  type FieldFeatures,
} from "../../../capture-replay/src/pii-classifier";

describe("classifyField — input type", () => {
  it("password type → password (100 confidence)", () => {
    const c = classifyField({ tagName: "input", inputType: "password" });
    expect(c.category).toBe("password");
    expect(c.confidence).toBe(100);
    expect(shouldMask(c)).toBe(true);
  });

  it("email type → email", () => {
    const c = classifyField({ tagName: "input", inputType: "email" });
    expect(c.category).toBe("email");
    expect(c.confidence).toBeGreaterThanOrEqual(MASK_THRESHOLD);
    expect(shouldMask(c)).toBe(true);
  });

  it("tel type → phone", () => {
    expect(classifyField({ tagName: "input", inputType: "tel" }).category).toBe("phone");
  });

  it("search type → not_pii", () => {
    const c = classifyField({ tagName: "input", inputType: "search" });
    expect(c.category).toBe("not_pii");
    expect(shouldMask(c)).toBe(false);
  });
});

describe("classifyField — autocomplete (HTML5 standard)", () => {
  it("cc-number → credit_card", () => {
    expect(classifyField({ tagName: "input", autocomplete: "cc-number" }).category).toBe("credit_card");
  });
  it("cc-csc → card_cvv", () => {
    expect(classifyField({ tagName: "input", autocomplete: "cc-csc" }).category).toBe("card_cvv");
  });
  it("current-password → password", () => {
    expect(classifyField({ tagName: "input", autocomplete: "current-password" }).category).toBe("password");
  });
  it("new-password → password", () => {
    expect(classifyField({ tagName: "input", autocomplete: "new-password" }).category).toBe("password");
  });
  it("postal-code → postal_code", () => {
    expect(classifyField({ tagName: "input", autocomplete: "postal-code" }).category).toBe("postal_code");
  });
  it("street-address → street_address", () => {
    expect(classifyField({ tagName: "input", autocomplete: "street-address" }).category).toBe("street_address");
  });
  it("bday → date_of_birth", () => {
    expect(classifyField({ tagName: "input", autocomplete: "bday" }).category).toBe("date_of_birth");
  });
});

describe("classifyField — name/label fuzzy matching", () => {
  it("name=cardNumber → credit_card", () => {
    expect(classifyField({ tagName: "input", name: "cardNumber" }).category).toBe("credit_card");
  });
  it("name=cvv → card_cvv", () => {
    expect(classifyField({ tagName: "input", name: "cvv" }).category).toBe("card_cvv");
  });
  it("labelText='Social Security Number' → ssn", () => {
    expect(classifyField({ tagName: "input", labelText: "Social Security Number" }).category).toBe("ssn");
  });
  it("placeholder='Date of Birth' → date_of_birth", () => {
    expect(classifyField({ tagName: "input", placeholder: "Date of Birth" }).category).toBe("date_of_birth");
  });
  it("name=email → email", () => {
    expect(classifyField({ tagName: "input", name: "email" }).category).toBe("email");
  });
  it("placeholder='Phone Number' → phone", () => {
    expect(classifyField({ tagName: "input", placeholder: "Phone Number" }).category).toBe("phone");
  });
  it("name=firstName → full_name", () => {
    expect(classifyField({ tagName: "input", name: "firstName" }).category).toBe("full_name");
  });
  it("ariaLabel='Passport Number' → government_id", () => {
    expect(classifyField({ tagName: "input", ariaLabel: "Passport Number" }).category).toBe("government_id");
  });
  it("name=api_key → api_secret", () => {
    expect(classifyField({ tagName: "input", name: "api_key" }).category).toBe("api_secret");
  });
  it("name=bearer_token → api_secret", () => {
    expect(classifyField({ tagName: "input", name: "bearer_token" }).category).toBe("api_secret");
  });
});

describe("classifyField — non-PII recognition", () => {
  it("name=search → not_pii", () => {
    const c = classifyField({ tagName: "input", name: "search" });
    expect(c.category).toBe("not_pii");
    expect(shouldMask(c)).toBe(false);
  });
  it("name=query → not_pii", () => {
    expect(classifyField({ tagName: "input", name: "query" }).category).toBe("not_pii");
  });
  it("placeholder='Leave a comment...' → not_pii", () => {
    expect(classifyField({ tagName: "textarea", placeholder: "Leave a comment..." }).category).toBe("not_pii");
  });
  it("labelText=Message → not_pii", () => {
    expect(classifyField({ tagName: "textarea", labelText: "Message" }).category).toBe("not_pii");
  });
});

describe("classifyField — uncertain fallback", () => {
  it("bare text input with no context → uncertain", () => {
    const c = classifyField({ tagName: "input", inputType: "text" });
    expect(c.category).toBe("uncertain");
    expect(c.confidence).toBe(0);
    expect(shouldMask(c)).toBe(false);
    expect(isUncertain(c)).toBe(true);
  });

  it("isUncertain true when confidence < UNCERTAIN_THRESHOLD for PII categories", () => {
    expect(isUncertain({ category: "email", confidence: UNCERTAIN_THRESHOLD - 1, reason: "weak" })).toBe(true);
    expect(isUncertain({ category: "email", confidence: UNCERTAIN_THRESHOLD + 1, reason: "strong" })).toBe(false);
  });

  it("isUncertain false for not_pii regardless of confidence", () => {
    expect(isUncertain({ category: "not_pii", confidence: 20, reason: "weak" })).toBe(false);
  });
});

describe("classifyField — priority / conflict resolution", () => {
  it("input type wins over fuzzy name match", () => {
    // type=password (100) must trump name=email (85)
    expect(classifyField({ tagName: "input", inputType: "password", name: "email" }).category).toBe("password");
  });

  it("autocomplete wins over conflicting name", () => {
    // autocomplete=cc-csc (100) beats name=ssn (90) — first match wins in rule order
    const c = classifyField({ tagName: "input", autocomplete: "cc-csc", name: "ssn" });
    expect(c.category).toBe("card_cvv");
  });
});

describe("hashFeatures", () => {
  const A: FieldFeatures = { tagName: "input", inputType: "text", name: "email" };
  const B: FieldFeatures = { tagName: "input", inputType: "text", name: "email" };
  const C: FieldFeatures = { tagName: "input", inputType: "text", name: "phone" };

  it("identical features produce identical hashes", () => {
    expect(hashFeatures(A)).toBe(hashFeatures(B));
  });

  it("different features produce different hashes", () => {
    expect(hashFeatures(A)).not.toBe(hashFeatures(C));
  });

  it("hashes are bounded strings", () => {
    const h = hashFeatures(A);
    expect(typeof h).toBe("string");
    expect(h.length).toBeLessThanOrEqual(12);
    expect(h.length).toBeGreaterThan(0);
  });
});

describe("classifyField — malformed input", () => {
  it("handles empty features object", () => {
    expect(classifyField({ tagName: "" }).category).toBe("uncertain");
  });

  it("handles undefined optional fields", () => {
    const c = classifyField({
      tagName: "input", inputType: undefined, name: undefined, placeholder: undefined,
    });
    expect(c.category).toBe("uncertain");
  });
});
