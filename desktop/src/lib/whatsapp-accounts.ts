/**
 * Read-side helper for the Baileys WhatsApp account list.
 *
 * Wraps `whatsapp_list_accounts` (Tauri IPC) and collapses the result
 * to the boolean the contact picker actually cares about: "does the
 * user have at least one WhatsApp account ready to send?". The other
 * statuses (qr_pending, disconnected, failed) don't enable sending.
 *
 * Kept distinct from `whatsapp-recipient.ts` — that module resolves
 * RECIPIENTS (who you message), whereas this one inspects SENDERS
 * (your own linked accounts). The two stores are independent on the
 * Rust side (`paired_entities` vs `whatsapp_accounts`).
 */

import { invoke } from "@tauri-apps/api/core";

export type WhatsAppConnectionStatus =
  | "disconnected"
  | "qr_pending"
  | "connected"
  | "reconnecting"
  | "failed";

export interface WhatsAppAccountInfo {
  account_id: string;
  label: string;
  self_jid: string | null;
  status: WhatsAppConnectionStatus;
  last_qr_at_ms: number | null;
  last_linked_at_ms: number | null;
}

/**
 * Fetch the raw account list. Empty array on IPC failure so callers
 * don't have to try/catch — under jsdom/vitest the command is
 * unregistered and we fall through to "no accounts".
 */
export async function listWhatsAppAccounts(): Promise<WhatsAppAccountInfo[]> {
  try {
    return await invoke<WhatsAppAccountInfo[]>("whatsapp_list_accounts");
  } catch {
    return [];
  }
}

/**
 * True when at least one account is in a state that can send. The
 * reconnecting state is included intentionally — Baileys typically
 * recovers within seconds and queuing a send is correct UX.
 */
export function hasSendableAccount(
  accounts: readonly WhatsAppAccountInfo[],
): boolean {
  return accounts.some(
    (a) => a.status === "connected" || a.status === "reconnecting",
  );
}
