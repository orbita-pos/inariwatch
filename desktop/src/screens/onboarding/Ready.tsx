import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  FolderTree,
  KeyRound,
  MessageSquare,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useOnboarding } from "@/lib/store/onboarding";
import { OnboardingFrame } from "./OnboardingFrame";

type ConnectChoice = "repo" | "cloud" | "skip" | null;

/**
 * Onboarding step 3 — Optional connect.
 *
 * Three equal options: Connect a repo / Connect InariWatch cloud /
 * Skip. The chat works standalone, so each is genuinely optional —
 * the design weights them the same on purpose.
 *
 * `acceptRepo` IPC stays the same; this screen just routes the user
 * through it when they pick the repo option. The progress card
 * surfaces while indexing runs, with an "Open Inari while it runs"
 * CTA so users aren't blocked.
 */
export function OnboardingReady() {
  const setStep = useOnboarding((s) => s.setStep);
  const repo = useOnboarding((s) => s.repo);
  const progress = useOnboarding((s) => s.progress);
  const errorMessage = useOnboarding((s) => s.errorMessage);
  const acceptRepo = useOnboarding((s) => s.acceptRepo);
  const pollProgress = useOnboarding((s) => s.pollProgress);
  const finishOnboarding = useOnboarding((s) => s.finishOnboarding);
  const [choice, setChoice] = useState<ConnectChoice>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        await pollProgress();
      } catch {
        /* swallow — backoff handled at IPC level */
      }
      if (!cancelled) setTimeout(tick, 800);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [repo, pollProgress]);

  const indexing = repo !== null && progress.stage !== "done";

  async function acceptDraftPath() {
    const trimmed = pathDraft.trim();
    if (trimmed.length === 0 || accepting) return;
    setAccepting(true);
    try {
      await acceptRepo(trimmed);
    } finally {
      setAccepting(false);
    }
  }

  const onPrimary = async () => {
    if (choice === "skip") {
      await finishOnboarding();
    } else if (choice === "cloud") {
      // Cloud auth flow lands in a follow-up; for now treat it as
      // "skip" so the user isn't blocked.
      await finishOnboarding();
    } else if (choice === "repo") {
      // If we already have a repo, finish — the indexing keeps
      // running in the background. The action label flips to
      // "Open Inari while it runs" to signal that.
      if (repo) {
        await finishOnboarding();
      } else {
        await acceptDraftPath();
      }
    }
  };

  // Forward action enabled when a choice is made AND, in the repo
  // case, we either already have a repo OR the user typed a non-empty
  // path. Keeps the CTA honest about whether it's actionable.
  const canContinue =
    choice !== null && (choice !== "repo" || repo !== null || pathDraft.trim().length > 0);
  const primaryLabel = indexing
    ? "Open Inari while it runs"
    : choice === "repo" && !repo
      ? "Index this folder"
      : "Open Inari";

  return (
    <OnboardingFrame
      step="ready"
      testId="onboarding-step-ready"
      actionBar={
        <>
          <button
            type="button"
            onClick={() => setStep("powerups")}
            data-testid="onboarding-connect-back"
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
            onClick={() => void onPrimary()}
            disabled={!canContinue}
            data-testid="onboarding-finish"
            className="h-9 px-5 rounded-lg text-[12.5px] font-medium flex items-center gap-2 transition-transform active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: "var(--accent)",
              color: "var(--accent-ink)",
              border: "1px solid rgba(0,0,0,0.18)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 0 rgba(0,0,0,0.45)",
            }}
          >
            {primaryLabel}
            <ArrowRight size={12} strokeWidth={2} />
          </button>
        </>
      }
    >
      <div className="absolute inset-0 overflow-auto">
        <div className="max-w-[600px] mx-auto pt-14 pb-10 px-8">
          <Eyebrow>Step 03 · connect (optional)</Eyebrow>

          {indexing ? (
            <IndexingHeader path={repo!.path} />
          ) : (
            <>
              <h2
                className="text-[26px] font-light tracking-[-0.02em] mt-3"
                style={{ color: "var(--text)" }}
              >
                Give Inari something to work with.
              </h2>
              <p
                className="text-[14px] mt-3 leading-[1.65] tracking-[-0.005em] max-w-[520px]"
                style={{ color: "var(--text-subtle)" }}
              >
                All three are equal — the chat works standalone. You can add
                either of the first two later from <Kbd>⌘,</Kbd> Settings →
                Connections.
              </p>
            </>
          )}

          {indexing ? (
            <IndexingCard
              path={repo!.path}
              percent={progress.percent}
              symbolCount={progress.symbol_count}
            />
          ) : (
            <div
              className="mt-9 overflow-hidden"
              style={{
                border: "1px solid var(--border-strong)",
                borderRadius: 12,
                background: "var(--surface)",
              }}
            >
              <PickerRow
                selected={choice === "repo"}
                onClick={() => setChoice("repo")}
                testId="onboarding-connect-repo"
                icon={<FolderTree size={14} strokeWidth={1.6} />}
                title="Connect a repository"
                helper="Inari can read code, files, and run guarded commands. Indexed locally — nothing leaves your machine."
                expanded={
                  choice === "repo" ? (
                    <RepoPathInput
                      value={pathDraft}
                      onChange={setPathDraft}
                      onSubmit={() => void acceptDraftPath()}
                      busy={accepting}
                      error={errorMessage}
                    />
                  ) : null
                }
              />
              <PickerRow
                selected={choice === "cloud"}
                onClick={() => setChoice("cloud")}
                testId="onboarding-connect-cloud"
                icon={<Cloud size={14} strokeWidth={1.6} />}
                title="Connect InariWatch cloud"
                helper="Imports alerts, deploys, and on-call schedules. Opens your browser to authorize this workstation."
              />
              <PickerRow
                selected={choice === "skip"}
                onClick={() => setChoice("skip")}
                testId="onboarding-connect-skip"
                icon={<MessageSquare size={14} strokeWidth={1.6} />}
                title="Skip — I just want to chat"
                helper={
                  <>
                    Open Inari now. Connect repos or InariWatch any time from{" "}
                    <span style={{ color: "var(--text-muted)" }}>
                      Settings → Connections
                    </span>
                    .
                  </>
                }
                isLast
              />
            </div>
          )}

          <div className="flex items-center justify-between mt-6">
            <div
              className="flex items-center gap-2 text-[11.5px]"
              style={{ color: "var(--text-faint)" }}
            >
              <KeyRound size={11} strokeWidth={1.6} style={{ color: "var(--verified)" }} />
              Every action Inari takes from here on is signed and stored locally.
            </div>
          </div>
        </div>
      </div>
    </OnboardingFrame>
  );
}

interface PickerRowProps {
  selected: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  helper: ReactNode;
  testId: string;
  isLast?: boolean;
  /**
   * Optional content rendered below the row's title/helper line when
   * the row is selected. Lets the row expand into an inline form
   * (e.g. the repo path input) without a separate popup or modal.
   */
  expanded?: ReactNode;
}

function PickerRow({
  selected,
  onClick,
  icon,
  title,
  helper,
  testId,
  isLast = false,
  expanded,
}: PickerRowProps) {
  return (
    <div
      data-testid={testId}
      data-selected={selected ? "true" : "false"}
      style={{
        background: selected
          ? "linear-gradient(180deg, rgba(239,233,220,0.04), rgba(239,233,220,0.015))"
          : "transparent",
        borderBottom: isLast ? "none" : "1px solid var(--border)",
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left flex items-start gap-3.5 px-4 py-3.5 transition-colors"
      >
        <span
          className="shrink-0 mt-0.5"
          style={{ color: selected ? "var(--accent)" : "var(--text-muted)" }}
        >
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <div
            className="text-[13.5px] tracking-[-0.005em]"
            style={{ color: "var(--text)" }}
          >
            {title}
          </div>
          <div
            className="text-[12px] mt-1 leading-[1.55]"
            style={{ color: "var(--text-subtle)" }}
          >
            {helper}
          </div>
        </div>
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
      </button>
      {expanded ? <div className="px-4 pb-4 -mt-1">{expanded}</div> : null}
    </div>
  );
}

interface RepoPathInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
}

function RepoPathInput({ value, onChange, onSubmit, busy, error }: RepoPathInputProps) {
  return (
    <div
      className="ml-[26px] mt-1"
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center gap-2"
        style={{
          padding: "0 0 0 0",
        }}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/path/to/repo  (or paste a folder)"
          aria-label="Repository path"
          data-testid="onboarding-connect-repo-input"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="flex-1 h-9 px-3 outline-none"
          style={{
            background: "rgba(255,255,255,0.025)",
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            color: "var(--text)",
            letterSpacing: "0.005em",
          }}
          autoFocus
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || value.trim().length === 0}
          data-testid="onboarding-connect-repo-accept"
          className="h-9 px-3.5 rounded-lg text-[12.5px] font-medium transition-transform active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: "var(--accent)",
            color: "var(--accent-ink)",
            border: "1px solid rgba(0,0,0,0.18)",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 0 rgba(0,0,0,0.45)",
          }}
        >
          {busy ? "Indexing…" : "Index"}
        </button>
      </div>
      <div
        className="text-[11.5px] mt-2 leading-[1.5]"
        style={{ color: error ? "var(--danger)" : "var(--text-faint)" }}
      >
        {error
          ? error
          : "Paste an absolute path, or drop a folder onto this field. Indexing runs locally."}
      </div>
    </div>
  );
}

interface IndexingCardProps {
  path: string;
  percent: number;
  symbolCount: number;
}

function IndexingCard({ path, percent, symbolCount }: IndexingCardProps) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className="mt-9 p-4"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border-strong)",
        borderRadius: 12,
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <FolderTree size={14} strokeWidth={1.6} style={{ color: "var(--text)" }} />
          <span
            className="text-[13px] truncate"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}
          >
            {path}
          </span>
        </div>
        <span
          className="text-[11.5px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text-subtle)" }}
        >
          {pct}%
        </span>
      </div>

      <div
        style={{
          height: 4,
          borderRadius: 999,
          background: "rgba(255,255,255,0.05)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "var(--accent)",
            borderRadius: 999,
            transition: "width 200ms",
          }}
        />
      </div>

      <div className="flex items-center justify-between mt-3">
        <div className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
            {symbolCount.toLocaleString()}
          </span>{" "}
          symbols indexed
        </div>
        <span className="text-[11.5px]" style={{ color: "var(--text-faint)" }}>
          {pct < 100 ? "running…" : "done"}
        </span>
      </div>

      <div
        className="border-t mt-4 pt-3 text-[11.5px] leading-[1.7]"
        style={{
          fontFamily: "var(--font-mono)",
          color: "var(--text-subtle)",
          borderColor: "rgba(239,233,220,0.10)",
        }}
      >
        <div>
          <span style={{ color: "var(--text-faint)" }}>indexing</span>{" "}
          {progressStageLabel(percent)}
        </div>
        <div style={{ color: "var(--text-dim)" }} className="mt-1">
          All indexing happens locally. No file content leaves your machine.
        </div>
      </div>
    </div>
  );
}

function IndexingHeader({ path }: { path: string }) {
  return (
    <>
      <h2
        className="text-[26px] font-light tracking-[-0.02em] mt-3 flex items-center gap-3"
        style={{ color: "var(--text)" }}
      >
        Indexing
        <span
          className="text-[14px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}
        >
          {path.split(/[\\/]/).pop()}
        </span>
      </h2>
      <p
        className="text-[14px] mt-3 leading-[1.65] tracking-[-0.005em]"
        style={{ color: "var(--text-subtle)" }}
      >
        Reading file headers, building a local symbol index. You can open Inari
        while this runs — she'll pick up new files as they finish.
      </p>
    </>
  );
}

function progressStageLabel(percent: number): string {
  if (percent < 25) return "scanning files";
  if (percent < 60) return "parsing symbols";
  if (percent < 95) return "building index";
  return "finalizing";
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
// keep `Check` imported even if unused after refactors so a future
// "skip · just chat" success state can drop it back in without churn.
void Check;
