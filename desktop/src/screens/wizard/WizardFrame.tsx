import { type ReactNode } from "react";

import { InariMark } from "@/screens/MainWindow";

interface WizardFrameProps {
  /**
   * Linear-style "Inari Live · setup" / "Inari Live · add project" /
   * etc. label rendered in the titlebar after the diamond mark.
   */
  subtitle: string;
  /**
   * The full step ordering — drives the dot indicator + the
   * `currentStep / total` mono counter.
   */
  steps: ReadonlyArray<string>;
  /** Index of the active step (0-based). Out-of-range falls back to 0. */
  currentStep: number;
  /**
   * Body slot. Lives inside an overflow:hidden container; render
   * scrollable content yourself if needed.
   */
  children: ReactNode;
  /**
   * Action bar slot. Pass a flex row with back/continue/cancel
   * buttons; the frame just provides the chrome (top border,
   * padding, height). Omit when the body owns its own action UI.
   */
  actionBar?: ReactNode;
  testId?: string;
}

/**
 * Generic wizard chrome. Lifted from `OnboardingFrame.tsx` so:
 *   * The 3-step onboarding flow keeps its existing skin via a thin
 *     wrapper that hardcodes ["drop", "powerups", "ready"] +
 *     subtitle="setup".
 *   * The Inari Live V1 Session 3 Add-Project wizard reuses the same
 *     visual identity with its own 5-step plan + subtitle="add project".
 *
 * Visual contract (light + dark theme via semantic CSS vars):
 *   - 40px frameless titlebar, drag region.
 *   - Diamond mark, "Inari Live", separator dot, subtitle.
 *   - Right side: dot indicator + monospace `N / total` counter.
 *   - Body: overflow:hidden, fills remaining height.
 *   - Optional 64px action bar at bottom with top border.
 */
export function WizardFrame({
  subtitle,
  steps,
  currentStep,
  children,
  actionBar,
  testId,
}: WizardFrameProps) {
  const stepIdx = Math.max(0, Math.min(steps.length - 1, currentStep));
  const ordinal = stepIdx + 1;

  return (
    <div
      data-testid={testId ?? "wizard-frame"}
      className="h-full w-full flex flex-col"
      style={{ background: "var(--bg)", color: "var(--text)" }}
    >
      <header
        data-tauri-drag-region
        className="flex items-center justify-between px-5 select-none shrink-0"
        style={{
          height: 40,
          borderBottom: "1px solid var(--border)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0) 70%)",
          cursor: "grab",
        }}
      >
        <div data-tauri-drag-region className="flex items-center gap-2">
          <InariMark size={14} />
          <span
            data-tauri-drag-region
            className="text-[12.5px] tracking-[-0.005em]"
            style={{ color: "var(--text-muted)" }}
          >
            Inari Live
          </span>
          <span
            data-tauri-drag-region
            style={{ color: "var(--text-faint)" }}
            className="mx-2"
          >
            ·
          </span>
          <span
            data-tauri-drag-region
            className="text-[11.5px]"
            style={{ color: "var(--text-dim)" }}
          >
            {subtitle}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {steps.map((step, i) => (
            <span
              key={`${step}-${i}`}
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background:
                  i < stepIdx
                    ? "var(--text-muted)"
                    : i === stepIdx
                      ? "var(--accent)"
                      : "rgba(255,255,255,0.08)",
              }}
            />
          ))}
          <span
            className="text-[11px] ml-2"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
          >
            {ordinal} / {steps.length}
          </span>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden relative">
        {children}
      </main>

      {actionBar ? (
        <div
          className="flex items-center justify-between px-6 shrink-0"
          style={{
            height: 64,
            borderTop: "1px solid var(--border)",
            background:
              "linear-gradient(0deg, rgba(255,255,255,0.012), rgba(255,255,255,0) 70%)",
          }}
        >
          {actionBar}
        </div>
      ) : null}
    </div>
  );
}
