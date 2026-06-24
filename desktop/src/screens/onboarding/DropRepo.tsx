import { useEffect, useState } from "react";
import { ArrowRight, KeyRound } from "lucide-react";

import { InariMark } from "@/screens/MainWindow";
import { useOnboarding } from "@/lib/store/onboarding";
import { OnboardingFrame } from "./OnboardingFrame";

/**
 * Onboarding step 1 — Welcome / the moat.
 *
 * The 2026-05-07 chat-first reframe replaced the old "drop a repo"
 * first impression with a calm welcome screen that lands the
 * cryptographic-receipt thesis once and lets the user click through
 * with no decision asked. Repo connection moves to step 3 alongside
 * cloud + skip, all equal weight.
 *
 * The store key stays `"drop"` for backwards compat with `MainBoot`
 * and the existing tests; the UI is what changed.
 */
export function OnboardingDropRepo() {
  const setStep = useOnboarding((s) => s.setStep);
  const [popoverOpen, setPopoverOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        setStep("powerups");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setStep]);

  return (
    <OnboardingFrame step="drop" testId="onboarding-step-drop">
      <div className="absolute inset-0 overflow-hidden">
        <FaintGlow />

        <div
          aria-hidden
          className="absolute"
          style={{ top: "18%", left: "12%", opacity: 0.55 }}
        >
          <FloatingWitness hash="w_3a1c8e9" />
        </div>
        <div
          aria-hidden
          className="absolute"
          style={{ top: "62%", right: "14%", opacity: 0.4 }}
        >
          <FloatingWitness hash="w_d12f4a0" />
        </div>
        <div
          aria-hidden
          className="absolute"
          style={{ bottom: "16%", left: "20%", opacity: 0.32 }}
        >
          <FloatingWitness hash="w_5e8b2f1" />
        </div>

        <div className="relative h-full flex flex-col items-center justify-center px-8 text-center">
          <div className="mb-7">
            <InariMark size={64} />
          </div>
          <h1
            className="text-[34px] font-light tracking-[-0.025em]"
            style={{ color: "var(--text)" }}
          >
            Inari Live
          </h1>
          <p
            className="text-[15px] mt-4 leading-[1.7] tracking-[-0.005em] max-w-[520px]"
            style={{ color: "var(--text-muted)" }}
          >
            An AI agent for production engineering.
            <br />
            <span style={{ color: "var(--text)" }}>
              Every action she takes is cryptographically signed
            </span>{" "}
            — you can verify any of it later.
          </p>

          <button
            type="button"
            onClick={() => setStep("powerups")}
            data-testid="onboarding-welcome-continue"
            className="h-10 px-5 rounded-lg text-[13.5px] font-medium mt-10 flex items-center gap-2 transition-transform active:scale-[0.98]"
            style={{
              background: "var(--accent)",
              color: "var(--accent-ink)",
              border: "1px solid rgba(0,0,0,0.18)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 0 rgba(0,0,0,0.45)",
            }}
          >
            Get started
            <ArrowRight size={13} strokeWidth={2} />
          </button>

          <button
            type="button"
            onClick={() => setPopoverOpen((v) => !v)}
            data-testid="onboarding-welcome-explainer"
            className="text-[12px] mt-7 transition-colors hover:text-[var(--text)]"
            style={{ color: "var(--text-subtle)" }}
          >
            What's a Witness receipt?
          </button>

          {popoverOpen ? <ExplainerPopover onClose={() => setPopoverOpen(false)} /> : null}
        </div>

        <div
          className="absolute left-6 bottom-3 text-[11px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
        >
          v0.5.0
        </div>
        <div
          className="absolute right-6 bottom-3 text-[11px]"
          style={{ color: "var(--text-faint)" }}
        >
          ⏎ continue
        </div>
      </div>
    </OnboardingFrame>
  );
}

function FaintGlow() {
  return (
    <div
      aria-hidden
      className="absolute"
      style={{
        top: "30%",
        left: "50%",
        width: 600,
        height: 600,
        transform: "translate(-50%, -30%)",
        background:
          "radial-gradient(circle at 50% 50%, rgba(239,233,220,0.045), rgba(239,233,220,0) 60%)",
        pointerEvents: "none",
      }}
    />
  );
}

function FloatingWitness({ hash }: { hash: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{
        height: 22,
        padding: "0 8px 0 7px",
        borderRadius: 999,
        background:
          "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))",
        border: "1px solid rgba(166,194,176,0.18)",
        color: "var(--verified)",
        fontSize: 11,
        lineHeight: 1,
      }}
    >
      <KeyRound size={10} strokeWidth={1.6} />
      <span style={{ color: "rgba(166,194,176,0.78)" }}>verified</span>
      <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          color: "#C8DDD0",
          letterSpacing: "0.01em",
        }}
      >
        {hash}
      </span>
    </span>
  );
}

interface ExplainerPopoverProps {
  onClose: () => void;
}

function ExplainerPopover({ onClose }: ExplainerPopoverProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      data-testid="onboarding-witness-popover"
      className="absolute"
      style={{
        top: "20%",
        right: "8%",
        maxWidth: 320,
        padding: "14px 16px",
        borderRadius: 12,
        background: "var(--surface)",
        border: "1px solid var(--border-strong)",
        boxShadow:
          "0 16px 40px -8px rgba(0,0,0,0.7), 0 4px 12px -2px rgba(0,0,0,0.4)",
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <KeyRound size={12} strokeWidth={1.6} style={{ color: "var(--verified)" }} />
        <span
          className="text-[12.5px] font-medium"
          style={{ color: "var(--text)" }}
        >
          Witness receipt
        </span>
      </div>
      <p
        className="text-[12.5px] leading-[1.6]"
        style={{ color: "var(--text-muted)" }}
      >
        Every tool call (file read, message sent, command run) is hashed and
        Ed25519-signed into a Merkle chain. Click any{" "}
        <span
          className="inline-flex items-center gap-1 px-1.5 align-middle"
          style={{
            height: 16,
            borderRadius: 999,
            background: "rgba(166,194,176,0.07)",
            border: "1px solid rgba(166,194,176,0.18)",
            color: "rgba(166,194,176,0.78)",
            fontSize: 9.5,
          }}
        >
          verified
        </span>{" "}
        chip later to inspect the receipt.
      </p>
    </div>
  );
}
