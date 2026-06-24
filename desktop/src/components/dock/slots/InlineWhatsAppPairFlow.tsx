/**
 * Phase 5.5 completion — inline WhatsApp pair flow for the dock.
 *
 * Wraps `WhatsAppPairDialog` with the Baileys IPC + Tauri events so
 * `ContactPickerSlot` can open the SAME pair surface a user sees in
 * Settings → Channels — but rendered as an overlay above the dock,
 * not as a navigation away from the slash command.
 *
 * Flow:
 *   1. Parent flips `open=true`.
 *   2. We invoke `whatsapp_login_start` with a fresh account-id and
 *      listen on `whatsapp:qr-update` / `whatsapp:linked`.
 *   3. On `qr-update` we feed the modal; on `linked` we refetch the
 *      paired-contact list and either auto-pick a matching entry or
 *      close cleanly (the picker stays mounted and refreshes).
 *
 * The auto-pick heuristic compares the digits of the linked self_jid
 * against the contact list — if the freshly linked phone shows up as
 * a paired contact (which can happen when the SAS path mirrors the
 * Baileys account), we resume the suspended command with that
 * recipient. Otherwise we don't fabricate a contact — the picker
 * re-renders with the refreshed list and the user can pick or type a
 * recipient deliberately.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { WhatsAppPairDialog } from "@/components/pairing/WhatsAppPairDialog";
import { listContacts } from "@/lib/slash/entities/contacts";
import type { ContactEntity } from "@/lib/slash/entities/types";

interface WhatsAppQrUpdateEvent {
  account_id: string;
  qr: string;
  ts_ms: number;
}

interface WhatsAppLinkedEvent {
  account_id: string;
  self_jid: string;
  ts_ms: number;
}

export interface InlineWhatsAppPairFlowProps {
  open: boolean;
  /** Modal dismissed (user clicked Cancel or pressed Esc, or pair completed without a contact match). */
  onClose: () => void;
  /**
   * Pair succeeded AND a matching contact exists in the paired list.
   * Caller typically resumes the suspended slash command by treating
   * this as the picked recipient.
   */
  onPaired: (contact: ContactEntity) => void;
}

function digitsOf(jid: string): string {
  return jid.split("@")[0]?.replace(/\D/g, "") ?? "";
}

export function InlineWhatsAppPairFlow({
  open,
  onClose,
  onPaired,
}: InlineWhatsAppPairFlowProps) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  // Kick off a fresh login session each time the modal opens. The
  // sidecar handles deduplication of identical account-ids; using a
  // timestamp-derived id keeps the modal stateless across reopens.
  useEffect(() => {
    if (!open) {
      setAccountId(null);
      setQr(null);
      return;
    }
    if (accountId) return;
    const fresh = `account-${Date.now().toString(36)}`;
    setAccountId(fresh);
    setQr(null);
    const stamp = new Date().toLocaleDateString();
    void invoke("whatsapp_login_start", {
      accountId: fresh,
      label: `Personal (${stamp})`,
    }).catch(() => {
      // Sidecar boot failures surface as a forever "Waiting for QR…"
      // state — the user cancels and Settings → Channels surfaces the
      // real error. Matching the Channels.tsx behaviour.
    });
  }, [open, accountId]);

  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    const unlistenFns: Array<Promise<UnlistenFn>> = [
      listen<WhatsAppQrUpdateEvent>("whatsapp:qr-update", (event) => {
        if (cancelled) return;
        if (event.payload.account_id === accountId) {
          setQr(event.payload.qr);
        }
      }),
      listen<WhatsAppLinkedEvent>("whatsapp:linked", async (event) => {
        if (cancelled) return;
        if (event.payload.account_id !== accountId) return;
        const linkedDigits = digitsOf(event.payload.self_jid);
        const fresh = await listContacts().catch(
          () => [] as ContactEntity[],
        );
        const match = fresh.find((c) => digitsOf(c.jid) === linkedDigits);
        if (match) {
          onPaired(match);
        } else {
          onClose();
        }
      }),
    ];
    return () => {
      cancelled = true;
      unlistenFns.forEach((p) =>
        p.then((fn) => fn()).catch(() => undefined),
      );
    };
  }, [open, accountId, onPaired, onClose]);

  return (
    <WhatsAppPairDialog
      open={open}
      qr={qr}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    />
  );
}
