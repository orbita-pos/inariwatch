/**
 * Fast non-cryptographic 32-bit hash (FNV-1a).
 *
 * Used by the redactor's `hashMode` option to produce stable per-value
 * suffixes ("[REDACTED_EMAIL:a1b2c3d4]") so log readers can correlate the
 * same redacted value across events without exposing the original text.
 *
 * Crypto strength is intentionally NOT required — these labels are
 * debugging aids, not authentication tokens. SHA-256 in the hot path
 * would blow the 5ms p95 budget for 5KB payloads.
 */
export declare function fnv1a32(input: string): string;
//# sourceMappingURL=hash.d.ts.map