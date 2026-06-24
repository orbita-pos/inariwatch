/**
 * Pairing code modal — 2026-05-07 design pivot (Frame 2).
 *
 * Centered card on the modal scrim showing:
 *   - Sage "awaiting scan" pulse pill at the top.
 *   - Inari fox glyph + "Pair {channel}" headline.
 *   - QR code stub + 8-char Crockford code letter-spaced large.
 *   - Helper line + countdown + Cancel link footer.
 */

import { useEffect, useMemo, useState } from "react";
import { QrCode } from "lucide-react";

import { InariMark } from "@/screens/MainWindow";
import { Dialog } from "@/components/ui";
import type { PendingPairingDto } from "@/lib/main-ipc";

export interface PairingCodeModalProps {
  open: boolean;
  pending: PendingPairingDto | null;
  onOpenChange: (open: boolean) => void;
}

export function PairingCodeModal({ open, pending, onOpenChange }: PairingCodeModalProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || !pending) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, pending]);

  const remaining = useMemo(() => {
    if (!pending) return 0;
    return Math.max(0, Math.floor((pending.expires_at_ms - now) / 1000));
  }, [pending, now]);

  const display = pending?.code_chunked ?? "—";
  const channelLabel = pending?.kind === "device" ? "Mobile device" : "WhatsApp";

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="!w-[420px] !max-w-[92vw] !p-0 overflow-hidden"
    >
      <div
        data-testid="pairing-code-modal"
        className="flex flex-col items-center px-7 py-7 relative"
        style={{ minHeight: 460 }}
      >
        {/* Awaiting scan pulse pill */}
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
          <span style={{ color: "rgba(166,194,176,0.78)" }}>awaiting scan</span>
        </span>

        <InariMark size={28} />
        <h3
          className="text-[18px] font-light tracking-[-0.018em] mt-3"
          style={{ color: "var(--text)" }}
        >
          Pair {channelLabel}
        </h3>

        {/* QR stub — replaced by a real QR when we wire generation */}
        <div
          className="mt-5 p-3.5"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
          }}
        >
          <QrPlaceholder code={pending?.code ?? "PENDING"} />
        </div>

        <div
          data-testid="pairing-code"
          className="mt-5 text-[22px]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--text)",
            letterSpacing: "0.16em",
          }}
          aria-label={`Pairing code ${display}`}
        >
          {display}
        </div>
        <p
          className="text-[12px] mt-2"
          style={{ color: "var(--text-subtle)" }}
        >
          scan or type this code on your phone
        </p>

        <div
          className="flex items-center w-full mt-auto pt-4"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <span
            className="text-[11.5px]"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}
          >
            {pending ? <>expires in <Countdown seconds={remaining} /></> : "generating…"}
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            data-testid="pairing-cancel"
            className="ml-auto text-[12px] hover:text-[var(--text)] transition-colors"
            style={{ color: "var(--text-subtle)" }}
          >
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}

interface QrPlaceholderProps {
  code: string;
}

function QrPlaceholder({ code }: QrPlaceholderProps) {
  // Deterministic faux-QR using a 21×21 grid seeded from the code so
  // each pairing renders distinctly. Real QR encoding lives behind a
  // future `qrcode` dep — placeholder is honest until then.
  const cells = useMemo(() => deriveCells(code), [code]);
  const px = 8; // cell size
  const N = 21;
  return (
    <svg
      width={N * px}
      height={N * px}
      viewBox={`0 0 ${N} ${N}`}
      shapeRendering="crispEdges"
      style={{ display: "block" }}
      aria-hidden
    >
      {/* finder patterns — top-left, top-right, bottom-left */}
      {[
        [0, 0],
        [14, 0],
        [0, 14],
      ].map(([fx, fy], i) => (
        <g key={i}>
          <rect x={fx} y={fy} width={7} height={7} fill="#16161a" />
          <rect x={fx + 1} y={fy + 1} width={5} height={5} fill="var(--accent)" />
          <rect x={fx + 2} y={fy + 2} width={3} height={3} fill="#16161a" />
        </g>
      ))}
      {cells.map((cell, idx) => (
        <rect
          key={idx}
          x={cell.x}
          y={cell.y}
          width={1}
          height={1}
          fill="var(--accent)"
        />
      ))}
    </svg>
  );
}

function deriveCells(code: string): Array<{ x: number; y: number }> {
  // FNV-1a seeded — populates the data area of the QR (8..20 columns,
  // 8..20 rows for the most part). Just enough chaos to look real.
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 8; y < 21; y++) {
    for (let x = 8; x < 21; x++) {
      h = (h * 16777619) ^ ((x + 1) * (y + 7));
      h = h >>> 0;
      if ((h & 0xff) > 128) out.push({ x, y });
    }
  }
  // Sprinkle some cells in the timing area for verisimilitude
  for (let i = 0; i < 7; i++) {
    h = (h * 16777619) >>> 0;
    if ((h & 0xff) > 160) out.push({ x: 6, y: 8 + i });
    if ((h & 0xff00) > 32000) out.push({ x: 8 + i, y: 6 });
  }
  return out;
}

function Countdown({ seconds }: { seconds: number }) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return (
    <span data-testid="pairing-countdown">
      {m.toString().padStart(2, "0")}:{s.toString().padStart(2, "0")}
    </span>
  );
}

// Lucide QrCode is not used directly — kept available for future affordances
// (e.g. "Open camera on phone" CTA in a follow-up).
void QrCode;
