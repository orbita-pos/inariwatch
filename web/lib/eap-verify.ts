/**
 * Sesión 29 — TypeScript port of `desktop/src-tauri/src/lib_eap_verify.rs`.
 *
 * Drives the public `verify.inariwatch.com` web verifier (`/verify`).
 * Bit-exact port of the S28 Rust verifier — every protocol constant
 * and decision below is locked to match. Any divergence breaks the
 * end-to-end contract (CLI passes a receipt, web rejects it).
 *
 * ## Canonical signing protocol (LOCKED — must mirror S28 byte-for-byte)
 *
 * ```text
 *   digest    = SHA-256(receipt_id_utf8_bytes)         // 32 bytes
 *   verified  = Ed25519.verify(public_key, digest, signature)
 *   key_id    = hex(SHA-256(public_key_bytes)[0..8])    // 16 hex chars
 * ```
 *
 * `receipt_id` is the lower-case 64-char hex Merkle root. Everything
 * ELSE in the `.eap.json` file (`prompt_hash`, `tools`, `files_read`,
 * `model`, `timestamp`, …) is display-only metadata — it is NOT
 * cryptographically committed by the signature. The Merkle root
 * commits to the substrate event stream that produced the receipt;
 * the signature commits to the Merkle root. That two-step is enough
 * for the audit story Sesión 27 surfaces in the dock.
 *
 * See `INARI_LIVE_DECISIONS.md` 2026-05-01 § Sesión 28 for why the
 * signed bytes are NOT canonical CBOR over the whole payload, and
 * 2026-05-01 § Sesión 29 for the disclosure-footer contract.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

/** Wire-format version embedded in every `.eap.json`. A verifier with
 *  no compatible version handler MUST refuse the file. */
export const EAP_FORMAT_VERSION = "eap-1";

const RECEIPT_ID_HEX_LEN = 64;
const SIGNATURE_HEX_LEN = 128;
const PUBKEY_HEX_LEN = 64;

/** On-disk shape of a `.eap.json` receipt file. Mirrors `EapReceipt`
 *  in `desktop/src-tauri/src/lib_eap_verify.rs`. */
export interface EapReceipt {
  version: string;
  receipt_id: string;
  merkle_root: string;
  /** `signed = false` means this is a Merkle-only receipt — the EAP
   *  server was deployed without an attestor keypair. The Merkle root
   *  is still tamper-evident on its own. */
  signed?: boolean;
  signature?: string | null;
  public_key?: string | null;
  key_id?: string | null;
  attestor?: string | null;

  /** Display-only metadata. NOT cryptographically committed. */
  prompt_hash?: string | null;
  system_prompt?: string | null;
  tools?: unknown;
  files_read?: unknown;
  model?: string | null;
  timestamp?: string | null;
  recording_id?: string | null;
}

export type VerifyOutcome =
  | { kind: "signed"; key_id: string }
  | { kind: "merkle-only" }
  | { kind: "signature-invalid" }
  | { kind: "malformed"; reason: string };

export function isPass(outcome: VerifyOutcome): boolean {
  return outcome.kind === "signed" || outcome.kind === "merkle-only";
}

export type ParseError =
  | { kind: "invalid-json"; message: string }
  | { kind: "unsupported-version"; got: string }
  | { kind: "shape"; message: string };

/** Parse a raw JSON string into a structurally-validated [`EapReceipt`].
 *  Returns either the receipt or a [`ParseError`]. Equivalent to the
 *  Rust `parse_receipt_str` (without the file-read step). */
export function parseReceipt(raw: string): EapReceipt | ParseError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "invalid-json",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "shape", message: "receipt must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  const version = typeof obj.version === "string" ? obj.version : null;
  const receipt_id =
    typeof obj.receipt_id === "string" ? obj.receipt_id : null;
  const merkle_root =
    typeof obj.merkle_root === "string" ? obj.merkle_root : null;
  if (version === null || receipt_id === null || merkle_root === null) {
    return {
      kind: "shape",
      message: "receipt must include version, receipt_id, and merkle_root",
    };
  }
  if (version !== EAP_FORMAT_VERSION) {
    return { kind: "unsupported-version", got: version };
  }

  const out: EapReceipt = {
    version,
    receipt_id,
    merkle_root,
    signed: typeof obj.signed === "boolean" ? obj.signed : false,
    signature: optString(obj.signature),
    public_key: optString(obj.public_key),
    key_id: optString(obj.key_id),
    attestor: optString(obj.attestor),
    prompt_hash: optString(obj.prompt_hash),
    system_prompt: optString(obj.system_prompt),
    tools: obj.tools,
    files_read: obj.files_read,
    model: optString(obj.model),
    timestamp: optString(obj.timestamp),
    recording_id: optString(obj.recording_id),
  };
  return out;
}

function optString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** The 32 bytes Ed25519 verifies against. MUST match the Rust verifier
 *  (`signed_digest` in `lib_eap_verify.rs`) and the legacy JS verifier
 *  (`verifyEd25519Signature` in `web/lib/services/eap-verify-local.ts`). */
export function signedDigest(receiptId: string): Uint8Array {
  return sha256(new TextEncoder().encode(receiptId));
}

/** Derive the stable 16-hex `key_id` from a 64-hex public key.
 *  Returns null if the input isn't 64 hex chars. */
export function deriveKeyId(publicKeyHex: string): string | null {
  if (publicKeyHex.length !== PUBKEY_HEX_LEN || !isHex(publicKeyHex)) {
    return null;
  }
  const pubkey = hexDecode(publicKeyHex);
  if (!pubkey || pubkey.length !== 32) return null;
  const digest = sha256(pubkey);
  return hexEncode(digest.slice(0, 8));
}

/** Verify a parsed receipt. Pure CPU — no I/O, no network. Safe to
 *  call with untrusted input: every field is bounds-checked before
 *  any crypto runs. */
export function verify(receipt: EapReceipt): VerifyOutcome {
  // ── Structural checks ────────────────────────────────────────────
  if (
    receipt.receipt_id.length !== RECEIPT_ID_HEX_LEN ||
    !isHex(receipt.receipt_id)
  ) {
    return { kind: "malformed", reason: "receipt_id must be 64 hex characters" };
  }
  if (
    receipt.merkle_root.length !== RECEIPT_ID_HEX_LEN ||
    !isHex(receipt.merkle_root)
  ) {
    return {
      kind: "malformed",
      reason: "merkle_root must be 64 hex characters",
    };
  }
  if (!eqIgnoreCase(receipt.merkle_root, receipt.receipt_id)) {
    return {
      kind: "malformed",
      reason: "merkle_root must equal receipt_id (content-addressed)",
    };
  }

  // ── Signed-or-not branch ────────────────────────────────────────
  const sigHex = receipt.signature ?? null;
  const pkHex = receipt.public_key ?? null;
  if (!sigHex || !pkHex) {
    if (receipt.signed) {
      return {
        kind: "malformed",
        reason: "signed=true but signature/public_key is missing",
      };
    }
    return { kind: "merkle-only" };
  }

  if (sigHex.length !== SIGNATURE_HEX_LEN || !isHex(sigHex)) {
    return {
      kind: "malformed",
      reason: "signature must be 128 hex characters",
    };
  }
  if (pkHex.length !== PUBKEY_HEX_LEN || !isHex(pkHex)) {
    return {
      kind: "malformed",
      reason: "public_key must be 64 hex characters",
    };
  }

  const sigBytes = hexDecode(sigHex);
  if (!sigBytes || sigBytes.length !== 64) {
    return { kind: "malformed", reason: "signature hex decode failed" };
  }
  const pkBytes = hexDecode(pkHex);
  if (!pkBytes || pkBytes.length !== 32) {
    return { kind: "malformed", reason: "public_key hex decode failed" };
  }

  // ── Ed25519 ──────────────────────────────────────────────────────
  // RFC 8032 / FIPS 186-5 strict mode (zip215=false). Matches Rust
  // ed25519-dalek's `verify_strict` semantics — rejects non-canonical
  // R and small-order keys.
  const digest = signedDigest(receipt.receipt_id);
  let ok = false;
  try {
    ok = ed25519.verify(sigBytes, digest, pkBytes, { zip215: false });
  } catch {
    // Malformed point / signature bytes raise. Treat as not-verified
    // rather than crashing the caller.
    ok = false;
  }
  if (!ok) {
    return { kind: "signature-invalid" };
  }
  const keyId =
    receipt.key_id ?? deriveKeyId(pkHex) ?? "";
  return { kind: "signed", key_id: keyId };
}

// ── Hex helpers (mirror lib_eap_verify.rs) ────────────────────────────

export function isHex(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x46) ||
      (c >= 0x61 && c <= 0x66);
    if (!ok) return false;
  }
  return true;
}

export function hexEncode(bytes: Uint8Array): string {
  const HEX = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[(b >> 4) & 0x0f];
    out += HEX[b & 0x0f];
  }
  return out;
}

export function hexDecode(s: string): Uint8Array | null {
  if (s.length % 2 !== 0) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexVal(s.charCodeAt(i * 2));
    const lo = hexVal(s.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

function eqIgnoreCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x >= 0x41 && x <= 0x5a) x += 0x20;
    if (y >= 0x41 && y <= 0x5a) y += 0x20;
    if (x !== y) return false;
  }
  return true;
}

// ── Shareable URL helpers ─────────────────────────────────────────────
//
// The /r/<base64> route lets users post a verification link directly
// to Twitter/HN without having to host the receipt JSON anywhere. A
// 2 KB receipt fits in a 2.7 KB URL after base64 — well under the
// 8 KB practical URL limit.

const SHAREABLE_MAX_BYTES = 4096;

/** Encode a receipt JSON string into a URL-safe base64 (no padding,
 *  `-`/`_` instead of `+`/`/`). Returns null when the encoded payload
 *  exceeds [`SHAREABLE_MAX_BYTES`] or the bytes cannot be encoded. */
export function encodeShareable(rawJson: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(rawJson);
  } catch {
    return null;
  }
  if (bytes.length > SHAREABLE_MAX_BYTES) return null;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  let b64: string;
  if (typeof btoa === "function") {
    b64 = btoa(bin);
  } else {
    b64 = Buffer.from(bytes).toString("base64");
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a URL-safe base64 segment back into the raw receipt JSON
 *  string. Returns null when the input is not a valid base64-url
 *  payload, or when the decoded bytes are larger than the shareable
 *  cap (defense against compression bombs). */
export function decodeShareable(segment: string): string | null {
  if (!segment) return null;
  // Restore standard base64 alphabet + padding.
  let std = segment.replace(/-/g, "+").replace(/_/g, "/");
  while (std.length % 4 !== 0) std += "=";
  let bytes: Uint8Array;
  try {
    if (typeof atob === "function") {
      const bin = atob(std);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new Uint8Array(Buffer.from(std, "base64"));
    }
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > SHAREABLE_MAX_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ── Public summary type (shared between page + API) ───────────────────

/** What the verifier renders to the user — same shape returned by the
 *  client-side path and the POST /api/verify endpoint. */
export interface VerifySummary {
  outcome: VerifyOutcome;
  /** Echo of the parsed receipt (or null when parsing failed). */
  receipt: EapReceipt | null;
  /** Parse-stage error, when [`parseReceipt`] returned a [`ParseError`]. */
  parseError: ParseError | null;
}

/** Run the full pipeline against a raw JSON string. Equivalent to:
 *
 *   parse → on error return parseError; else verify → return outcome. */
export function verifyRaw(rawJson: string): VerifySummary {
  const parsed = parseReceipt(rawJson);
  if (!("version" in parsed)) {
    return {
      outcome: { kind: "malformed", reason: parseErrorReason(parsed) },
      receipt: null,
      parseError: parsed,
    };
  }
  const outcome = verify(parsed);
  return { outcome, receipt: parsed, parseError: null };
}

export function parseErrorReason(err: ParseError): string {
  switch (err.kind) {
    case "invalid-json":
      return `invalid JSON — ${err.message}`;
    case "unsupported-version":
      return `unsupported receipt version "${err.got}" (expected "${EAP_FORMAT_VERSION}")`;
    case "shape":
      return err.message;
  }
}
