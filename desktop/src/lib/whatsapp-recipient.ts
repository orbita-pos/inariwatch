/**
 * `/whatsapp` recipient resolver — turns a user-typed display-name (or
 * raw E.164 number) into the full phone the `comm.send_whatsapp` tool
 * needs.
 *
 * Privacy note: `listPairedWhatsApp` is the ONLY frontend caller of
 * `desktop_whatsapp_list_paired`, the only IPC that returns unredacted
 * phones. The other paired-entity IPC (`desktop_pairing_list`)
 * deliberately redacts. We accept this scoped relaxation because the
 * full phone is needed to actually send a message — there's no way
 * around it.
 */

import { invoke } from "@tauri-apps/api/core";

export interface WhatsAppPaired {
  entity_id: string;
  display_name: string;
  /** E.164 with leading `+`. Goes verbatim into `comm.send_whatsapp.to`. */
  phone: string;
  /** Redacted form like "+52 ••••5678". Used in disambiguation hints. */
  redacted: string;
}

/**
 * Tagged result of resolving a `/whatsapp <recipient>` query against
 * the user's paired list. Each variant maps 1:1 to a chat-surface
 * error message in the slash dispatcher.
 */
export type WhatsAppResolution =
  | {
      ok: true;
      phone: string;
      display_name: string;
      redacted: string;
    }
  | { ok: false; reason: "none-paired" }
  | { ok: false; reason: "not-found"; available: string[] }
  | { ok: false; reason: "ambiguous"; candidates: WhatsAppPaired[] };

/** E.164 shape — `+` then 7-15 digits. Same regex the `comm.send_whatsapp` tool enforces. */
const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * IPC wrapper for `desktop_whatsapp_list_paired`. Returns the list
 * of unrevoked paired phone entities WITH their full E.164. Catches
 * IPC errors and returns an empty list so the resolver doesn't have
 * to try/catch — empty is treated as "none paired".
 */
export async function listPairedWhatsApp(): Promise<WhatsAppPaired[]> {
  try {
    return await invoke<WhatsAppPaired[]>("desktop_whatsapp_list_paired");
  } catch {
    return [];
  }
}

/**
 * Find paired entities whose `display_name` matches the query. Match
 * rules (in priority order):
 *
 *   1. Exact (case-insensitive) — `Mom` matches "Mom"
 *   2. First-word prefix — `mo` matches "Mom" and "Monica"
 *
 * Returns ALL matches; the caller decides what to do with multiple
 * (slash dispatcher: ambiguous-match error).
 *
 * Pure function — exposed for tests.
 */
export function matchByDisplayName(
  query: string,
  paired: readonly WhatsAppPaired[],
): readonly WhatsAppPaired[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  // 1. Exact match (highest priority — if a display_name IS the query,
  //    don't widen to prefix matches that include it).
  const exact = paired.filter(
    (p) => p.display_name.toLowerCase() === q,
  );
  if (exact.length > 0) return exact;

  // 2. First-word prefix match.
  return paired.filter((p) => {
    const firstWord = p.display_name.toLowerCase().split(/\s+/)[0] ?? "";
    return firstWord.startsWith(q);
  });
}

/**
 * Resolve a user-typed query to a target paired WhatsApp.
 *
 * - If the query is a valid E.164 (`+1234...`), pass it through —
 *   the user might be sending to someone NOT in the paired list. The
 *   tool's schema will validate it again on the way to the backend;
 *   if Baileys rejects the JID, that's a runtime error the user gets
 *   from the tool, not the resolver.
 *
 * - Otherwise look up by display_name. The four return paths surface
 *   distinct chat messages so the user knows what to do next.
 */
export async function resolveWhatsAppRecipient(
  query: string,
): Promise<WhatsAppResolution> {
  const trimmed = query.trim();

  // Raw E.164 escape hatch — bypass the paired-list lookup.
  if (E164.test(trimmed)) {
    return {
      ok: true,
      phone: trimmed,
      display_name: trimmed,
      redacted: trimmed,
    };
  }

  const paired = await listPairedWhatsApp();
  if (paired.length === 0) {
    return { ok: false, reason: "none-paired" };
  }

  const matches = matchByDisplayName(trimmed, paired);
  if (matches.length === 0) {
    return {
      ok: false,
      reason: "not-found",
      available: paired.map((p) => p.display_name),
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      // Frontend only renders the first 5; we send the full set so
      // tests can lock the ordering without relying on an arbitrary
      // truncation point.
      candidates: matches as WhatsAppPaired[],
    };
  }

  const m = matches[0]!;
  return {
    ok: true,
    phone: m.phone,
    display_name: m.display_name,
    redacted: m.redacted,
  };
}

/**
 * Split `/whatsapp <recipient> <body>` args into its two parts.
 * Returns `{ error }` when either side is empty. Pure function.
 */
export function parseWhatsAppArgs(
  args: string,
): { recipient: string; message: string } | { error: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      error: "Recipient + message required. Try `/whatsapp Mom Hola`.",
    };
  }
  const m = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) {
    return {
      error: "Message body required. Try `/whatsapp Mom <message>`.",
    };
  }
  const recipient = m[1]!;
  const message = m[2]!.trim();
  if (!message) {
    return { error: "Message body cannot be empty." };
  }
  return { recipient, message };
}
