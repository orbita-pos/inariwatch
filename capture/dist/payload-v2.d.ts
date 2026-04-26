/**
 * Payload v2 — frozen wire contract (Track A, SKYNET §3 piece 1+4+17).
 *
 * v1 talked to a human dashboard. v2 talks to an LLM. Every field exists
 * because a model needs it to localize, hypothesize, or apply a fix without
 * a separate round trip.
 *
 * The wire shape is a strict superset of v1. Servers detect v2 by
 * `schema_version === "2.0"`; v1 callers keep working unchanged.
 *
 * Frozen as of 2026-04-25 — every track B-H of the SKYNET plan reads/writes
 * this shape. Additive changes only. Renames or removals are a major bump.
 *
 * Wire format (snake_case at the boundary, camelCase only inside legacy
 * compat fields). The transformer in `buildPayloadV2` handles the conversion
 * from the in-memory `ErrorEvent` (camelCase, used by integrations) to this
 * canonical shape.
 *
 * Crypto contract — must stay byte-identical to `web/lib/services/eap-verify-local.ts`:
 *   leaf            = SHA-256(canonical_json(evidence))
 *   merkle_root     = SHA-256(leaf || leaf)            // single-leaf, duplicate-pad
 *   receipt_id_hex  = hex(merkle_root)
 *   sign_digest     = SHA-256(receipt_id_hex_utf8_bytes)
 *   signature       = Ed25519.sign(private_key, sign_digest)
 *
 * Canonical JSON: object keys sorted alphabetically, recursively. Arrays keep
 * order. Strings stringified through `JSON.stringify` (escapes match RFC 8259).
 *
 * Zero deps. Crypto comes from `node:crypto` (Ed25519 supported since Node 15;
 * we target Node ≥20). Falls back to a no-op signature on Edge / Browser.
 */
import type { ErrorEvent, Breadcrumb, SourceContextFrame, RuntimeSnap, Precursor, Hypothesis, FleetMatch, IntentContract, CausalGraph } from "./types.js";
export type SeverityV2 = "critical" | "error" | "warning" | "info";
export interface SignatureBlock {
    /** Algorithm tag — frozen. */
    alg: "ed25519";
    /** First 16 hex chars of SHA-256(public_key_bytes). Stable across the install lifetime. */
    pub_key_id: string;
    /** Hex of the 32-byte Ed25519 public key. Lets the server verify without a keypair lookup. */
    signer_pubkey: string;
    /** 64-hex SHA-256 Merkle root over the canonical evidence pack. Equal to receipt_id. */
    evidence_merkle_root: string;
    /** 128-hex Ed25519 signature over SHA-256(evidence_merkle_root). */
    sig: string;
    /** ISO 8601 — when the SDK signed this event. */
    signed_at: string;
}
export interface RequestContextV2 {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    ip?: string;
}
export interface DeployContextV2 {
    sha?: string;
    diff_urls?: string[];
    risk_tags?: string[];
    age_seconds?: number;
}
export interface CohortContextV2 {
    users_hit?: number;
    rps_delta?: number;
    canary_pct?: number;
}
export interface NearMissV2 {
    signal: string;
    delta_pct: number;
    window_seconds: number;
}
/** AI-shaped evidence pack — every field is optional, only what the SDK collected appears. */
export interface EvidencePack {
    stack: Array<{
        file: string;
        line: number;
        col?: number;
        function: string;
        locals?: Record<string, unknown>;
        closure?: Record<string, unknown>;
        source_slice?: {
            before: string[];
            line: string;
            after: string[];
        };
        git_blame?: {
            commit: string;
            author: string;
            date: string;
            message: string;
        };
        tokens_estimated: number;
    }>;
    breadcrumbs?: Breadcrumb[];
    request?: RequestContextV2;
    response_expected_schema?: IntentContract[];
    deploy?: DeployContextV2;
    flags?: Record<string, string>;
    experiments?: Record<string, string>;
    runtime_snap?: RuntimeSnap;
    precursors?: Precursor[];
    near_misses_last_60s?: NearMissV2[];
    cohort?: CohortContextV2;
    tokens_estimated_total: number;
}
/** Top-level frozen wire contract. */
export interface ErrorEventV2 {
    schema_version: "2.0";
    fingerprint: string;
    title: string;
    severity: SeverityV2;
    timestamp: string;
    evidence: EvidencePack;
    hypotheses: Hypothesis[];
    graph?: CausalGraph;
    embedding_v1?: number[];
    fleet_match?: FleetMatch;
    signature: SignatureBlock;
    body?: string;
    environment?: string;
    release?: string;
    runtime?: "nodejs" | "edge" | "python" | "go" | "rust" | "jvm" | "dotnet" | "browser";
    user?: {
        id?: string;
        role?: string;
    };
    tags?: Record<string, string>;
}
export declare const PAYLOAD_V2_JSON_SCHEMA: {
    readonly $schema: "http://json-schema.org/draft-07/schema#";
    readonly $id: "https://inariwatch.com/schemas/capture/error-event-v2.json";
    readonly title: "ErrorEventV2";
    readonly type: "object";
    readonly required: readonly ["schema_version", "fingerprint", "title", "severity", "timestamp", "evidence", "hypotheses", "signature"];
    readonly additionalProperties: true;
    readonly properties: {
        readonly schema_version: {
            readonly const: "2.0";
        };
        readonly fingerprint: {
            readonly type: "string";
            readonly pattern: "^[0-9a-f]{64}$";
        };
        readonly title: {
            readonly type: "string";
            readonly maxLength: 1000;
        };
        readonly severity: {
            readonly enum: readonly ["critical", "error", "warning", "info"];
        };
        readonly timestamp: {
            readonly type: "string";
            readonly format: "date-time";
        };
        readonly evidence: {
            readonly type: "object";
            readonly required: readonly ["stack", "tokens_estimated_total"];
            readonly properties: {
                readonly stack: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "object";
                        readonly required: readonly ["file", "line", "function", "tokens_estimated"];
                        readonly properties: {
                            readonly file: {
                                readonly type: "string";
                            };
                            readonly line: {
                                readonly type: "integer";
                                readonly minimum: 0;
                            };
                            readonly col: {
                                readonly type: "integer";
                                readonly minimum: 0;
                            };
                            readonly function: {
                                readonly type: "string";
                            };
                            readonly locals: {
                                readonly type: "object";
                            };
                            readonly closure: {
                                readonly type: "object";
                            };
                            readonly source_slice: {
                                readonly type: "object";
                                readonly required: readonly ["before", "line", "after"];
                                readonly properties: {
                                    readonly before: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly line: {
                                        readonly type: "string";
                                    };
                                    readonly after: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                            };
                            readonly git_blame: {
                                readonly type: "object";
                                readonly required: readonly ["commit", "author", "date", "message"];
                                readonly properties: {
                                    readonly commit: {
                                        readonly type: "string";
                                    };
                                    readonly author: {
                                        readonly type: "string";
                                    };
                                    readonly date: {
                                        readonly type: "string";
                                    };
                                    readonly message: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly tokens_estimated: {
                                readonly type: "integer";
                                readonly minimum: 0;
                            };
                        };
                    };
                };
                readonly breadcrumbs: {
                    readonly type: "array";
                };
                readonly request: {
                    readonly type: "object";
                };
                readonly response_expected_schema: {
                    readonly type: "array";
                };
                readonly deploy: {
                    readonly type: "object";
                };
                readonly flags: {
                    readonly type: "object";
                };
                readonly experiments: {
                    readonly type: "object";
                };
                readonly runtime_snap: {
                    readonly type: "object";
                };
                readonly precursors: {
                    readonly type: "array";
                };
                readonly near_misses_last_60s: {
                    readonly type: "array";
                };
                readonly cohort: {
                    readonly type: "object";
                };
                readonly tokens_estimated_total: {
                    readonly type: "integer";
                    readonly minimum: 0;
                };
            };
        };
        readonly hypotheses: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["text", "prior", "cites", "confidence", "source"];
                readonly properties: {
                    readonly text: {
                        readonly type: "string";
                    };
                    readonly prior: {
                        readonly type: "number";
                        readonly minimum: 0;
                        readonly maximum: 1;
                    };
                    readonly cites: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly confidence: {
                        readonly type: "number";
                        readonly minimum: 0;
                        readonly maximum: 1;
                    };
                    readonly source: {
                        readonly enum: readonly ["local_agent", "bloom_match", "heuristic"];
                    };
                };
            };
        };
        readonly graph: {
            readonly type: "object";
        };
        readonly embedding_v1: {
            readonly type: "array";
            readonly items: {
                readonly type: "number";
            };
        };
        readonly fleet_match: {
            readonly type: "object";
        };
        readonly signature: {
            readonly type: "object";
            readonly required: readonly ["alg", "pub_key_id", "signer_pubkey", "evidence_merkle_root", "sig", "signed_at"];
            readonly properties: {
                readonly alg: {
                    readonly const: "ed25519";
                };
                readonly pub_key_id: {
                    readonly type: "string";
                    readonly pattern: "^[0-9a-f]{16}$";
                };
                readonly signer_pubkey: {
                    readonly type: "string";
                    readonly pattern: "^[0-9a-f]{64}$";
                };
                readonly evidence_merkle_root: {
                    readonly type: "string";
                    readonly pattern: "^[0-9a-f]{64}$";
                };
                readonly sig: {
                    readonly type: "string";
                    readonly pattern: "^[0-9a-f]{128}$";
                };
                readonly signed_at: {
                    readonly type: "string";
                    readonly format: "date-time";
                };
            };
        };
    };
};
/**
 * Canonical JSON encoder — sorts object keys alphabetically, recursively.
 * Byte-identical to `canonicalJsonStringify` in
 * `web/lib/services/eap-verify-local.ts`. Server reuses this when it
 * recomputes the Merkle root.
 *
 * Arrays preserve order. Primitives go through `JSON.stringify` so escape
 * rules match RFC 8259 (and the Rust `serde_json` impl in eap/crates/receipt).
 */
export declare function canonicalJsonStringify(value: unknown): string;
/**
 * tiktoken-compatible token estimator without the dependency.
 *
 * Approach: tuned single-rate `chars × 0.28` against measured tiktoken
 * `cl100k_base` rates across 100 sample payloads (English error text, JS
 * stack traces, JSON evidence packs, code snippets). The empirical rate
 * varies between 0.24 and 0.33 tokens/char depending on punctuation
 * density; 0.28 hits the mean.
 *
 *   tokens ≈ ceil(char_count × 0.28)
 *
 * Acceptance (PAYLOAD_V2_SPEC.md): <10% mean error vs tiktoken `cl100k_base`
 * across the test corpus. Verified in payload-v2.test.mjs.
 *
 * For non-string values we serialize once (canonical) and run the same rate
 * so callers can pass any payload subtree.
 *
 * Pathological inputs (long repeated single-char runs like "aaaa...") will
 * undershoot — BPE merges those into very few tokens and our estimator can't
 * cheaply detect that. Real payloads don't contain such runs; the SDK's
 * fingerprint+evidence shape is well-mixed text.
 */
export declare function estimateTokensTiktoken(value: unknown): number;
/**
 * Compute the Merkle root over the evidence pack using single-leaf,
 * duplicate-last padding (matches `recomputeMerkleRoot` in eap-verify-local).
 *
 *   leaf = SHA-256(canonical_json(evidence))
 *   root = SHA-256(leaf || leaf)         // odd → duplicate
 *
 * Returns 64-char lowercase hex.
 *
 * Pure CPU; safe to call sync. Uses node:crypto when available, falls back
 * to Web Crypto via the async overload `computeEvidenceMerkleRootAsync`.
 */
export declare function computeEvidenceMerkleRootSync(evidence: EvidencePack, crypto: any): string;
export declare function computeEvidenceMerkleRootAsync(evidence: EvidencePack): Promise<string>;
/**
 * Convert the in-memory `ErrorEvent` (which integrations have already
 * enriched with `forensics`, `sourceContext`, `hypotheses`, etc.) into the
 * canonical wire shape `ErrorEventV2`. Does NOT sign — that's a separate
 * step in `signing.ts` so the unsigned shape is testable and the signing
 * key path stays optional (Edge / Browser SDKs cannot persist a keypair).
 *
 * The transformer is purely structural: no I/O, no async, no globals.
 * Same input always produces the same output (deterministic).
 */
export declare function buildEvidencePack(event: ErrorEvent): EvidencePack;
/**
 * Build v2 wire payload WITHOUT signing. Caller layers the signature on top
 * via `signing.ts` so the signing path stays Node-only.
 *
 * Returned object is the exact JSON the server will receive (minus the
 * `signature` block — that lives in the wrapper that calls `signPayload`).
 */
export declare function buildPayloadV2Unsigned(event: ErrorEvent): Omit<ErrorEventV2, "signature">;
interface ParsedFrame {
    file: string;
    line: number;
    col?: number;
    function: string;
}
/**
 * Best-effort stack parser. Handles V8 ("at fn (file:line:col)") and Firefox
 * ("fn@file:line:col") formats. Accepts an optional sourceContext list — when
 * the SDK already has structured frames we skip parsing.
 *
 * Falls back to a single synthetic "<unknown>" frame if parsing finds nothing
 * (Edge / minified code without source maps). Server gates downstream
 * features on whether `evidence.stack[0].file` is "<unknown>".
 */
export declare function parseStackForEvidence(stack: string, sourceContext?: SourceContextFrame[]): ParsedFrame[];
export {};
//# sourceMappingURL=payload-v2.d.ts.map