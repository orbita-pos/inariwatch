/**
 * Inari Live Phase 5.2 — contact entity provider.
 *
 * Wraps the existing `desktop_whatsapp_list_paired` IPC (the only one
 * that returns unredacted phones) and collapses the
 * `WhatsAppPaired` rows into the generic `ContactEntity` shape the
 * picker expects.
 *
 * For now the provider is WhatsApp-only — Telegram and Slack land
 * with their own pickers once those messengers gain a paired-list
 * IPC. The provider's contract is "named recipients", which means a
 * future Telegram-aware version would union the lists transparently.
 *
 * Phase 5.5 completion adds the recent-contacts persistence layer:
 * `listRecentContacts` / `touchRecentContact` survive app restarts so
 * the picker can promote "people you've messaged recently" across
 * sessions, not just within one dock lifetime.
 */
import { invoke } from "@tauri-apps/api/core";

import {
  listPairedWhatsApp,
  type WhatsAppPaired,
} from "../../whatsapp-recipient";

import type { ContactEntity } from "./types";

/**
 * Internal mapping helper — exported for tests so we can verify the
 * boundary contract without monkey-patching the IPC.
 */
export function toContactEntity(p: WhatsAppPaired): ContactEntity {
  return {
    jid: p.phone,
    name: p.display_name,
    redacted: p.redacted,
  };
}

/**
 * Return the paired contacts available to this device. Returns an
 * empty array when no IPC is available (vitest / jsdom / storybook),
 * matching how `listPairedWhatsApp` swallows IPC errors.
 *
 * Test-only injection via `deps.list` so unit tests can stub the
 * paired list without poking the Tauri runtime.
 */
export interface ListContactsDeps {
  list?: () => Promise<WhatsAppPaired[]>;
}

export async function listContacts(
  deps: ListContactsDeps = {},
): Promise<ContactEntity[]> {
  const list = deps.list ?? listPairedWhatsApp;
  const paired = await list();
  return paired.map(toContactEntity);
}

// ── Recent contacts persistence (Phase 5.5 completion) ─────────────────

/**
 * Wire shape returned by `desktop_recent_contacts_list`. Mirrors the
 * `RecentContact` Rust struct (`store::recent_contacts`).
 */
interface RecentContactRow {
  jid: string;
  name: string;
  last_used_at: number;
}

/**
 * Return the most-recently-messaged contacts, newest first. Capped
 * at `limit` on the Rust side (clamped to [1, 20]). Empty array on
 * IPC failure — Tauri-less runtimes (vitest, storybook) fall through
 * gracefully.
 */
export async function listRecentContacts(
  limit = 10,
  deps: { invoke?: typeof invoke } = {},
): Promise<ContactEntity[]> {
  const ipc = deps.invoke ?? invoke;
  try {
    const rows = await ipc<RecentContactRow[]>(
      "desktop_recent_contacts_list",
      { limit },
    );
    return rows.map((r) => ({
      jid: r.jid,
      name: r.name,
      // The Rust side doesn't store a redacted form — derive it from
      // the jid here so the picker can keep its existing row layout
      // (the contact-picker suppresses this column when name === jid,
      // matching the common raw-phone case).
      redacted: redactedFromJid(r.jid),
    }));
  } catch {
    return [];
  }
}

/**
 * Touch a contact's row with the current time. Idempotent on `jid`
 * (storage layer collapses dups + updates the timestamp + display
 * name). Best-effort: failure is silent so a transient store hiccup
 * never blocks the slash dispatch that called this.
 *
 * Returns `true` on success, `false` on any error.
 */
export async function touchRecentContact(
  jid: string,
  name: string,
  deps: { invoke?: typeof invoke } = {},
): Promise<boolean> {
  if (!jid.trim()) return false;
  const ipc = deps.invoke ?? invoke;
  try {
    await ipc("desktop_recent_contacts_touch", { jid, name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure helper kept local so consumers don't have to import the picker.
 * Mirrors `redactedFromJid` in `ContactPickerSlot.tsx` (last 4 digits
 * with `…` prefix; passthrough on too-short input).
 */
function redactedFromJid(jid: string): string {
  const digits = jid.replace(/\D/g, "");
  if (digits.length < 4) return jid;
  return `…${digits.slice(-4)}`;
}
