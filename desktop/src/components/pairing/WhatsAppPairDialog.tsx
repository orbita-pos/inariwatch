/**
 * WhatsApp Baileys pair dialog.
 *
 * Opened by Settings → Channels → "Pair new WhatsApp" and by the
 * /whatsapp slash flow when the contact picker has no paired
 * recipients yet (Phase 5.5 completion). The component is the QR-only
 * presentation surface — the parent owns `whatsapp_login_start` and
 * the `whatsapp:qr-update` / `whatsapp:linked` event listeners that
 * feed it `qr`.
 *
 * Extracted from `screens/settings/Channels.tsx` so the dock-side
 * inline pair flow can render the SAME modal a user sees in Settings
 * — avoiding a second QR widget that would drift.
 */
import { QRCodeSVG } from "qrcode.react";

import { Button, Dialog, DialogClose } from "@/components/ui";

export interface WhatsAppPairDialogProps {
  open: boolean;
  qr: string | null;
  onOpenChange: (open: boolean) => void;
}

export function WhatsAppPairDialog({ open, qr, onOpenChange }: WhatsAppPairDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Scan with WhatsApp"
      description="Open WhatsApp → Settings → Linked devices → Link a device. Then scan this code."
    >
      <div
        data-testid="whatsapp-pair-modal"
        className="flex flex-col gap-3 text-center"
      >
        <div
          data-testid="whatsapp-qr-canvas"
          className="self-center rounded-[var(--radius-md)] bg-white p-4"
        >
          {qr ? (
            <QRCodeSVG value={qr} size={224} level="M" />
          ) : (
            <span className="block w-56 h-56 grid place-items-center text-xs text-neutral-500">
              Waiting for QR…
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--muted)]">
          QR refreshes every 20 seconds until paired.
        </p>
        <DialogClose asChild>
          <Button variant="ghost" size="sm" data-testid="whatsapp-pair-cancel">
            Cancel
          </Button>
        </DialogClose>
      </div>
    </Dialog>
  );
}
