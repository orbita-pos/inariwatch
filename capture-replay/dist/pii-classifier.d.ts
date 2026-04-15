/**
 * PII classifier for browser input fields.
 *
 * Two tiers:
 *   1. Heuristics — synchronous, runs on every input. 90%+ recall on obvious
 *      cases (password, credit card, email, phone, SSN, DOB, address).
 *   2. AI (optional) — batched server call for fields the heuristic marked
 *      as "uncertain". Enabled via ReplayConfig.piiClassifier = "ai".
 *
 * Outputs a `PiiCategory` plus a confidence score. Callers apply the
 * `iw-mask` class to DOM nodes that scored at or above a threshold —
 * rrweb then masks their captured values automatically.
 *
 * Pure functions — zero DOM dependencies so they're unit-testable.
 */
export type PiiCategory = "password" | "credit_card" | "card_cvv" | "ssn" | "email" | "phone" | "date_of_birth" | "full_name" | "street_address" | "postal_code" | "government_id" | "api_secret" | "not_pii" | "uncertain";
export interface FieldFeatures {
    /** Normalized tag name, e.g. "input", "textarea". */
    tagName: string;
    /** The HTML `type` attribute, e.g. "password", "email", "tel". */
    inputType?: string;
    /** The `name` attribute. */
    name?: string;
    /** The `id` attribute. */
    id?: string;
    /** Placeholder text. */
    placeholder?: string;
    /** `aria-label` if set. */
    ariaLabel?: string;
    /** Text content of the associated <label> element (or nearby label). */
    labelText?: string;
    /** The `autocomplete` attribute (HTML5 autofill hint — super high signal). */
    autocomplete?: string;
}
export interface Classification {
    category: PiiCategory;
    /** 0-100. ≥70 means we're confident enough to auto-mask. */
    confidence: number;
    /** Human-readable note for debugging ("matched: type=password"). */
    reason: string;
}
/** Confidence cutoff at or above which the caller should apply iw-mask. */
export declare const MASK_THRESHOLD = 70;
/** Below this, the heuristic sends the field to the AI classifier (if enabled). */
export declare const UNCERTAIN_THRESHOLD = 50;
/**
 * Classify a field by features. Returns the best match, or `uncertain`
 * if no rule fires — callers may then forward it to the AI endpoint.
 */
export declare function classifyField(features: FieldFeatures): Classification;
/**
 * Should the caller apply `iw-mask` based on this classification?
 * Only true when we're confident the field holds PII.
 */
export declare function shouldMask(c: Classification): boolean;
/**
 * Is this classification too weak to trust on its own? When `true`,
 * the caller should escalate to the server-side AI tier (if enabled).
 */
export declare function isUncertain(c: Classification): boolean;
/**
 * Stable hash of the features — used as a cache key for AI results so
 * identical fields across pages/sessions don't pay for re-classification.
 * djb2, truncated to 12 hex chars.
 */
export declare function hashFeatures(features: FieldFeatures): string;
//# sourceMappingURL=pii-classifier.d.ts.map