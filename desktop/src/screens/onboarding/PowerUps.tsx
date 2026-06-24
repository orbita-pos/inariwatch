import { ArrowLeft, ArrowRight, Check, ChevronDown, KeyRound } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useOnboarding } from "@/lib/store/onboarding";
import { OnboardingFrame } from "./OnboardingFrame";

type KeyChoice = "platform" | "byok" | null;
type Provider = "claude" | "openai" | "groq" | "grok" | "deepseek" | "gemini";

const PROVIDERS: Array<{ value: Provider; label: string; swatch: string }> = [
  { value: "claude",   label: "Claude",   swatch: "#D97757" },
  { value: "openai",   label: "OpenAI",   swatch: "#10A37F" },
  { value: "groq",     label: "Groq",     swatch: "#F55036" },
  { value: "grok",     label: "Grok",     swatch: "#888690" },
  { value: "deepseek", label: "DeepSeek", swatch: "#4D6BFE" },
  { value: "gemini",   label: "Gemini",   swatch: "#4285F4" },
];

/**
 * Onboarding step 2 — AI key.
 *
 * The 2026-05-07 chat-first reframe replaced the old "power-ups"
 * feature gallery with a single-decision step: which key does Inari
 * think with? Platform key (free, $0.10/day cap, default) or BYOK.
 *
 * Default-on platform option means most users click Continue without
 * typing anything — the BYOK card is there for power users who want
 * their own bill / their own model.
 *
 * Persisting the actual key choice to the AI settings store is a
 * follow-up — for now the UI captures the user's intent locally and
 * the existing `Settings → AI` panel remains the source of truth.
 */
export function OnboardingPowerUps() {
  const setStep = useOnboarding((s) => s.setStep);
  const [choice, setChoice] = useState<KeyChoice>("platform");
  const [provider, setProvider] = useState<Provider>("claude");
  const [providerOpen, setProviderOpen] = useState(false);
  const [keyValue, setKeyValue] = useState("");

  const canContinue = choice === "platform" || (choice === "byok" && keyValue.trim().length > 8);

  return (
    <OnboardingFrame
      step="powerups"
      testId="onboarding-step-powerups"
      actionBar={
        <>
          <button
            type="button"
            onClick={() => setStep("drop")}
            data-testid="onboarding-aikey-back"
            className="h-9 px-4 rounded-lg text-[12.5px] flex items-center gap-2 transition-colors hover:bg-white/[0.025]"
            style={{
              background: "transparent",
              color: "var(--text-muted)",
              border: "1px solid var(--border-strong)",
            }}
          >
            <ArrowLeft size={12} strokeWidth={2} />
            Back
          </button>
          <button
            type="button"
            onClick={() => setStep("ready")}
            disabled={!canContinue}
            data-testid="onboarding-powerups-continue"
            className="h-9 px-5 rounded-lg text-[12.5px] font-medium flex items-center gap-2 transition-transform active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: "var(--accent)",
              color: "var(--accent-ink)",
              border: "1px solid rgba(0,0,0,0.18)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 0 rgba(0,0,0,0.45)",
            }}
          >
            Continue
            <ArrowRight size={12} strokeWidth={2} />
          </button>
        </>
      }
    >
      <div className="absolute inset-0 overflow-auto">
        <div className="max-w-[600px] mx-auto pt-14 pb-10 px-8">
          <Eyebrow>Step 02 · AI key</Eyebrow>
          <h2
            className="text-[26px] font-light tracking-[-0.02em] mt-3"
            style={{ color: "var(--text)" }}
          >
            Pick a key for Inari to think with.
          </h2>
          <p
            className="text-[14px] mt-3 leading-[1.65] tracking-[-0.005em]"
            style={{ color: "var(--text-subtle)" }}
          >
            You can change this any time from <Kbd>⌘,</Kbd> Settings → AI.
          </p>

          <div className="flex flex-col gap-2.5 mt-9">
            <OptCard
              selected={choice === "platform"}
              onClick={() => setChoice("platform")}
              testId="onboarding-aikey-platform"
              icon={
                <svg width="14" height="14" viewBox="0 0 14 14">
                  <path
                    d="M7 1.2 L12.8 7 L7 12.8 L1.2 7 Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.1"
                  />
                  <circle cx="7" cy="7" r="1.9" fill="currentColor" />
                </svg>
              }
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="text-[14.5px] tracking-[-0.005em]"
                  style={{ color: "var(--text)" }}
                >
                  Use Inari's platform key
                </span>
                <CapBadge />
              </div>
              <p
                className="text-[12.5px] mt-2 leading-[1.6]"
                style={{ color: "var(--text-subtle)" }}
              >
                No setup. Routed through Inari's billing. Falls through to your own
                keys when the daily cap is exhausted; resumes at midnight UTC.
              </p>
            </OptCard>

            <OptCard
              selected={choice === "byok"}
              onClick={() => setChoice("byok")}
              testId="onboarding-aikey-byok"
              icon={<KeyRound size={14} strokeWidth={1.6} />}
            >
              <div
                className="text-[14.5px] tracking-[-0.005em]"
                style={{ color: "var(--text)" }}
              >
                I'll bring my own
              </div>
              <p
                className="text-[12.5px] mt-2 leading-[1.6]"
                style={{ color: "var(--text-subtle)" }}
              >
                Paste a key from any of: Claude, OpenAI, Groq, Grok, DeepSeek,
                Gemini. Stored encrypted on this workstation, never sent to Inari.
              </p>

              {choice !== "byok" ? (
                <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                  {PROVIDERS.map((p) => (
                    <span
                      key={p.value}
                      className="text-[10.5px]"
                      style={{
                        fontFamily: "var(--font-mono)",
                        color: "var(--text-faint)",
                      }}
                    >
                      {p.label.toLowerCase()}
                      {p !== PROVIDERS[PROVIDERS.length - 1] ? (
                        <span style={{ color: "var(--text-faint)" }}> · </span>
                      ) : null}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mt-4 grid grid-cols-[140px_1fr] gap-2 relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setProviderOpen((v) => !v);
                    }}
                    className="h-9 px-2.5 rounded-md flex items-center justify-between transition-colors hover:bg-white/[0.025]"
                    style={{
                      background: "rgba(255,255,255,0.018)",
                      border: "1px solid var(--border-strong)",
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-sm"
                        style={{ background: PROVIDERS.find((p) => p.value === provider)!.swatch }}
                      />
                      <span style={{ color: "var(--text)" }}>
                        {PROVIDERS.find((p) => p.value === provider)!.label}
                      </span>
                    </span>
                    <ChevronDown size={11} strokeWidth={2} style={{ color: "var(--text-dim)" }} />
                  </button>
                  <input
                    type="password"
                    value={keyValue}
                    onChange={(e) => setKeyValue(e.target.value)}
                    placeholder="sk-…"
                    onClick={(e) => e.stopPropagation()}
                    data-testid="onboarding-aikey-input"
                    className="h-9 px-3 rounded-md outline-none"
                    style={{
                      background: "rgba(255,255,255,0.018)",
                      border: "1px solid var(--border-strong)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 12.5,
                      color: "var(--text)",
                      letterSpacing: "0.02em",
                    }}
                  />
                  {providerOpen ? (
                    <ProviderMenu
                      selected={provider}
                      onSelect={(p) => {
                        setProvider(p);
                        setProviderOpen(false);
                      }}
                      onClose={() => setProviderOpen(false)}
                    />
                  ) : null}
                </div>
              )}
            </OptCard>
          </div>

          <div className="flex items-center justify-between mt-7">
            <button
              type="button"
              onClick={() => setStep("ready")}
              data-testid="onboarding-powerups-skip"
              className="text-[12px] transition-colors hover:text-[var(--text)]"
              style={{ color: "var(--text-subtle)" }}
            >
              Decide later
            </button>
            <div
              className="flex items-center gap-2 text-[11.5px]"
              style={{ color: "var(--text-faint)" }}
            >
              <Check size={11} strokeWidth={2} />
              Keys are encrypted with your OS keychain
            </div>
          </div>
        </div>
      </div>
    </OnboardingFrame>
  );
}

interface OptCardProps {
  selected: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
  testId: string;
}

function OptCard({ selected, onClick, icon, children, testId }: OptCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-selected={selected ? "true" : "false"}
      className="text-left transition-colors w-full"
      style={{
        padding: "16px 18px",
        borderRadius: 12,
        background: selected
          ? "linear-gradient(180deg, rgba(239,233,220,0.04), rgba(239,233,220,0.015))"
          : "var(--surface)",
        border: `1px solid ${selected ? "rgba(239,233,220,0.30)" : "var(--border-strong)"}`,
      }}
    >
      <div className="flex items-start gap-4">
        <span
          className="shrink-0 mt-0.5"
          style={{ color: selected ? "var(--accent)" : "var(--text-muted)" }}
        >
          {icon}
        </span>
        <div className="flex-1 min-w-0">{children}</div>
        <span
          aria-hidden
          className="shrink-0 mt-1"
          style={{
            width: 14,
            height: 14,
            borderRadius: 999,
            border: `1.5px solid ${selected ? "var(--accent)" : "var(--border-3)"}`,
            background: selected ? "var(--accent)" : "transparent",
            boxShadow: selected ? "inset 0 0 0 3px var(--bg)" : undefined,
          }}
        />
      </div>
    </button>
  );
}

function CapBadge() {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{
        height: 19,
        padding: "0 8px",
        borderRadius: 999,
        background:
          "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))",
        border: "1px solid rgba(166,194,176,0.18)",
        color: "var(--verified)",
        fontSize: 10,
        lineHeight: 1,
      }}
    >
      <span style={{ color: "rgba(166,194,176,0.78)" }}>included</span>
      <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
      <span style={{ fontFamily: "var(--font-mono)", color: "#C8DDD0" }}>
        $0.10/day cap
      </span>
    </span>
  );
}

interface ProviderMenuProps {
  selected: Provider;
  onSelect: (p: Provider) => void;
  onClose: () => void;
}

function ProviderMenu({ selected, onSelect, onClose }: ProviderMenuProps) {
  return (
    <>
      <div
        aria-hidden
        className="fixed inset-0"
        style={{ zIndex: 30 }}
        onClick={onClose}
      />
      <div
        role="menu"
        className="absolute"
        style={{
          top: 40,
          left: 0,
          width: 200,
          background: "#131318",
          border: "1px solid var(--border-strong)",
          borderRadius: 10,
          padding: 6,
          boxShadow:
            "0 16px 40px -8px rgba(0,0,0,0.7), 0 4px 12px -2px rgba(0,0,0,0.4)",
          zIndex: 31,
        }}
      >
        {PROVIDERS.map((p) => {
          const isSelected = p.value === selected;
          return (
            <button
              key={p.value}
              type="button"
              role="menuitem"
              onClick={() => onSelect(p.value)}
              className="w-full flex items-center gap-2.5 px-2.5 transition-colors hover:bg-white/[0.025]"
              style={{
                height: 30,
                borderRadius: 6,
                background: isSelected ? "rgba(255,255,255,0.04)" : "transparent",
                color: isSelected ? "var(--text)" : "var(--text-muted)",
                fontSize: 13,
              }}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm"
                style={{ background: p.swatch }}
              />
              <span>{p.label}</span>
              {isSelected ? (
                <Check size={11} strokeWidth={2} className="ml-auto" style={{ color: "var(--accent)" }} />
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-[10.5px] font-medium"
      style={{
        color: "var(--text-faint)",
        letterSpacing: "0.16em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center justify-center px-1.5 align-middle"
      style={{
        height: 18,
        borderRadius: 4,
        background: "rgba(255,255,255,0.04)",
        border: "1px solid var(--border-strong)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text-muted)",
      }}
    >
      {children}
    </span>
  );
}
