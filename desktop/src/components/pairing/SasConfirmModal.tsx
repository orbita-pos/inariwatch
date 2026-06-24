/**
 * SAS confirmation modal — 2026-05-07 design pivot (Frame 3).
 *
 * Centered card showing:
 *   - "verifying" pulse pill at the top.
 *   - Sage key+ring glyph + "Confirm both screens show this number."
 *     headline.
 *   - Sage-tinted panel with the 6-digit SAS, letter-spaced wide,
 *     formatted as `47-829-3` for readability.
 *   - Two stacked buttons (cream "These match — confirm pairing"
 *     primary / soft-red ghost "These don't match — abort").
 *   - Footnote line about MITM.
 */

import { KeyRound } from "lucide-react";

import { Dialog } from "@/components/ui";

export interface SasPendingState {
  challenge_id: string;
  channel: "whatsapp" | "telegram" | "slack" | "mobile";
  identifier_redacted: string;
  display_name: string;
  sas_digits: string;
}

export interface SasConfirmModalProps {
  open: boolean;
  state: SasPendingState | null;
  onMatch: (challengeId: string) => void;
  onReject: (challengeId: string) => void;
  onOpenChange: (open: boolean) => void;
}

function formatSas(digits: string): string {
  const clean = digits.replace(/\D/g, "");
  if (clean.length === 6) {
    return `${clean.slice(0, 2)}-${clean.slice(2, 5)}-${clean.slice(5)}`;
  }
  if (clean.length === 7) {
    return `${clean.slice(0, 3)}-${clean.slice(3, 6)}-${clean.slice(6)}`;
  }
  return clean;
}

export function SasConfirmModal({
  open,
  state,
  onMatch,
  onReject,
  onOpenChange,
}: SasConfirmModalProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="!w-[420px] !max-w-[92vw] !p-0 overflow-hidden"
    >
      <div
        data-testid="sas-confirm-modal"
        className="flex flex-col items-center px-7 py-7 relative"
        style={{ minHeight: 460 }}
      >
        {state ? (
          <>
            {/* Verifying pulse */}
            <span
              className="absolute inline-flex items-center gap-1.5"
              style={{
                top: 14,
                right: 14,
                height: 22,
                padding: "0 9px",
                borderRadius: 999,
                background:
                  "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))",
                border: "1px solid rgba(166,194,176,0.18)",
                color: "var(--verified)",
                fontSize: 11,
                lineHeight: 1,
              }}
            >
              <span
                aria-hidden
                className="animate-pulse"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--verified)",
                }}
              />
              <span style={{ color: "rgba(166,194,176,0.78)" }}>verifying</span>
            </span>

            {/* Key + ring glyph */}
            <div
              className="flex items-center justify-center mt-1"
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                border: "1px solid rgba(166,194,176,0.4)",
                color: "var(--verified)",
              }}
            >
              <KeyRound size={18} strokeWidth={1.6} />
            </div>

            <h3
              className="mt-3.5 text-[17px] font-light tracking-[-0.018em] text-center"
              style={{ color: "var(--text)", maxWidth: 280, lineHeight: 1.4 }}
            >
              Confirm both screens show this number.
            </h3>

            {/* Identifier */}
            <div
              className="text-[11.5px] mt-2"
              style={{ color: "var(--text-subtle)" }}
            >
              {state.display_name}{" "}
              <span style={{ color: "var(--text-faint)" }}>·</span>{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {state.identifier_redacted}
              </span>
            </div>

            {/* Sage-tinted SAS panel */}
            <div
              data-testid="sas-digits"
              className="w-full mt-5 py-4 flex items-center justify-center"
              style={{
                background:
                  "linear-gradient(180deg, rgba(166,194,176,0.08), rgba(166,194,176,0.03))",
                border: "1px solid rgba(166,194,176,0.22)",
                borderRadius: 12,
              }}
              aria-label={`SAS digits ${state.sas_digits}`}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--text)",
                  fontSize: 32,
                  letterSpacing: "0.18em",
                }}
              >
                {formatSas(state.sas_digits)}
              </span>
            </div>

            <p
              className="text-[11.5px] text-center mt-3"
              style={{ color: "var(--text-subtle)", maxWidth: 280, lineHeight: 1.5 }}
            >
              Signal-style verification — cryptographically prevents{" "}
              <span style={{ whiteSpace: "nowrap" }}>man-in-the-middle</span>{" "}
              pairing.
            </p>

            <div className="w-full mt-4 flex flex-col gap-2">
              <button
                type="button"
                data-testid="sas-match"
                onClick={() => onMatch(state.challenge_id)}
                className="rounded-lg flex items-center justify-center transition-transform active:scale-[0.98]"
                style={{
                  height: 38,
                  background: "var(--accent)",
                  color: "var(--accent-ink)",
                  border: "1px solid rgba(0,0,0,0.18)",
                  boxShadow:
                    "inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 0 rgba(0,0,0,0.45)",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                These match — confirm pairing
              </button>
              <button
                type="button"
                data-testid="sas-reject"
                onClick={() => onReject(state.challenge_id)}
                className="rounded-lg flex items-center justify-center transition-colors hover:bg-white/[0.025]"
                style={{
                  height: 36,
                  background: "transparent",
                  color: "var(--denied)",
                  border: "1px solid rgba(208,133,133,0.22)",
                  fontSize: 12.5,
                }}
              >
                These don't match — abort
              </button>
            </div>

            <p
              className="text-[10.5px] text-center mt-3"
              style={{ color: "var(--text-faint)", maxWidth: 280, lineHeight: 1.5 }}
            >
              If the device shows different digits, someone may be intercepting
              your pairing request.
            </p>
          </>
        ) : (
          <div className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
            No pending pairing.
          </div>
        )}
      </div>
    </Dialog>
  );
}
