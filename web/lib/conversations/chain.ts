/**
 * Conversation witness chain — Inari Live V1 Session 5.
 *
 * Every server-stamped message commits to the prior message via
 * `message_hash = SHA256(role || canonical(content_json) || prev_message_hash)`.
 * That makes the whole conversation a hash-linked list — tampering with
 * any message breaks the chain at that row, which `/witness verify`
 * detects without needing per-message signatures (which S6 already
 * supplies for tool calls).
 *
 * Why SHA-256 (not BLAKE3 as the architecture proposal mentioned):
 *   * Already used elsewhere in the codebase (`web/lib/eap-verify.ts`,
 *     webhooks/shared.ts) via `@noble/hashes/sha2` and node `crypto`.
 *   * One less dep, identical security posture for tamper-evidence.
 *   * The chain-verify logic is identical regardless of primitive.
 *
 * Canonical JSON:
 *   The chain commits to a stable string form of `content_json` so that
 *   adding/removing whitespace or re-ordering keys can't be used to
 *   slip a different payload past the verify pass. We sort keys
 *   recursively before stringifying — same approach the EAP receipt
 *   verifier uses for its prompt-hash field.
 */

import { sha256 } from "@noble/hashes/sha2.js";

const enc = new TextEncoder();

/** Serialise a value into a deterministic, key-sorted JSON string. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, sortKeys);
}

function sortKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Compute the chain hash for a single message. Returns lowercase hex.
 *
 * Inputs:
 *   - role: 'user' | 'assistant' | 'tool' | 'system'
 *   - contentJson: the message payload as it lives in the DB row
 *   - prevHash: the previous message's `message_hash`, or `null` for
 *     the seed message (first row in a conversation).
 */
export function computeMessageHash(
  role: string,
  contentJson: unknown,
  prevHash: string | null,
): string {
  const payload = `${role}\n${canonicalJson(contentJson)}\n${prevHash ?? ""}`;
  const digest = sha256(enc.encode(payload));
  return toHex(digest);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

export interface ChainRow {
  id: string;
  role: string;
  contentJson: unknown;
  prevMessageHash: string | null;
  messageHash: string | null;
}

export interface VerifyChainResult {
  /** True when every row's stored `message_hash` matches the recompute. */
  ok: boolean;
  /** Total rows walked. */
  totalMessages: number;
  /** First row that broke the chain — null when `ok` is true. */
  firstBreakAt: {
    messageId: string;
    expected: string;
    actual: string | null;
    reason: "missing_hash" | "wrong_prev" | "wrong_hash";
  } | null;
}

/**
 * Walk a conversation's messages in chronological order and recompute
 * each `message_hash`. The first row whose stored hash disagrees with
 * the recompute is reported back so the UI can highlight it.
 *
 * Edge case — partially-stamped chains (legacy rows pre-S5): rows with
 * `message_hash === null` are treated as `unverifiable` rather than
 * `tampered`. The caller decides how loud to be; the slash command
 * surfaces a ⚠ chip in that case.
 */
export function verifyChain(rows: ChainRow[]): VerifyChainResult {
  let prev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.prevMessageHash !== prev) {
      return {
        ok: false,
        totalMessages: rows.length,
        firstBreakAt: {
          messageId: row.id,
          expected: prev ?? "",
          actual: row.prevMessageHash,
          reason: "wrong_prev",
        },
      };
    }
    if (row.messageHash === null) {
      return {
        ok: false,
        totalMessages: rows.length,
        firstBreakAt: {
          messageId: row.id,
          expected: computeMessageHash(row.role, row.contentJson, prev),
          actual: null,
          reason: "missing_hash",
        },
      };
    }
    const expected = computeMessageHash(row.role, row.contentJson, prev);
    if (expected !== row.messageHash) {
      return {
        ok: false,
        totalMessages: rows.length,
        firstBreakAt: {
          messageId: row.id,
          expected,
          actual: row.messageHash,
          reason: "wrong_hash",
        },
      };
    }
    prev = row.messageHash;
  }
  return { ok: true, totalMessages: rows.length, firstBreakAt: null };
}
