"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronRight, Clock, ExternalLink, KeyRound } from "lucide-react";

import { cn, formatRelativeTime } from "@/lib/utils";
import { dispatchConversationSlash } from "@/lib/conversations/web-slash-dispatch";

interface ContextPanelProps {
  conversation: {
    id: string;
    title: string;
    state: "active" | "snoozed" | "resolved" | "archived";
    anchorAlertId: string | null;
    snoozedUntil: string | null;
    resolvedAt: string | null;
    resolutionSummary: string | null;
  };
  alert: {
    id: string;
    title: string;
    severity: string;
    body: string;
    isRead: boolean;
    isResolved: boolean;
    sourceIntegrations: string[];
    createdAt: string;
  } | null;
}

/**
 * Right-rail context panel. Three modes (per locked decision):
 *   * Mode A — alert-anchored. Shows alert metadata, source, quick actions.
 *   * Mode B — free conversation. Shows project picker (V1 stub) + Save.
 *   * Mode C — resolved. Shows resolution summary + reopen.
 *
 * The panel is always visible on web/desktop; collapse-on-mobile lives
 * in CSS via the layout's grid (handled by the parent).
 *
 * Quick-action buttons dispatch the same slash commands as the
 * composer — single SSOT for state transitions. The /witness verify
 * row sits in the panel header so a user can verify with one click
 * without typing.
 */
export function ContextPanel({ conversation, alert }: ContextPanelProps) {
  const isResolved = conversation.state === "resolved";
  const isFree     = !alert;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-base/60">
          {isResolved ? "Mode C · Resolved" : isFree ? "Mode B · Free" : "Mode A · Alert"}
        </span>
        <VerifyBadgeLauncher conversationId={conversation.id} />
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {alert ? <ModeA alert={alert} /> : null}
        {!alert ? <ModeB /> : null}
        {isResolved ? <ModeC conversation={conversation} alert={alert} /> : null}

        <QuickActions
          conversationId={conversation.id}
          state={conversation.state}
          anchored={!!alert}
        />
      </div>
    </div>
  );
}

function ModeA({ alert }: { alert: NonNullable<ContextPanelProps["alert"]> }) {
  const sevColor =
    alert.severity === "critical" ? "text-inari-accent" :
    alert.severity === "warning"  ? "text-amber-600 dark:text-amber-400" :
    "text-blue-600 dark:text-blue-400";

  return (
    <section className="px-4 py-4 space-y-4">
      <Section title="Alert">
        <p className={cn("text-xs font-medium uppercase tracking-wider", sevColor)}>{alert.severity}</p>
        <p className="mt-1 text-sm text-fg-strong leading-snug">{alert.title}</p>
        <p className="mt-2 text-xs text-fg-base/60 line-clamp-3">{alert.body}</p>
      </Section>

      <Section title="Source">
        <div className="flex flex-wrap gap-1">
          {alert.sourceIntegrations.length === 0 ? (
            <span className="text-xs text-fg-base/50">unknown</span>
          ) : (
            alert.sourceIntegrations.map((src) => (
              <span
                key={src}
                className="rounded border border-line-medium bg-surface-dim px-1.5 py-0.5 font-mono text-[11px] text-fg-base"
              >
                {src}
              </span>
            ))
          )}
        </div>
      </Section>

      <Section title="Timeline">
        <p className="font-mono text-[11px] text-fg-base/60">
          arrived {formatRelativeTime(new Date(alert.createdAt))}
        </p>
      </Section>

      <Section title="Cross-device">
        <p className="text-[11px] text-fg-base/60">
          Continue on Inari Live for local-tool actions · open the desktop app
        </p>
      </Section>

      <Section title="Legacy view">
        <Link
          href={`/alerts/${alert.id}`}
          className="inline-flex items-center gap-1 text-[11px] text-fg-base/70 hover:text-fg-base"
        >
          Open as alert page
          <ExternalLink aria-hidden className="h-3 w-3" />
        </Link>
      </Section>
    </section>
  );
}

function ModeB() {
  return (
    <section className="px-4 py-4 space-y-4">
      <Section title="Conversation">
        <p className="text-xs text-fg-base/60">
          Free conversation — not anchored to an alert.
        </p>
      </Section>

      <Section title="Project context">
        <p className="text-[11px] text-fg-base/60">
          Pick an active project (coming in V1.5) to ground tool calls. For now
          this conversation runs without a project anchor.
        </p>
      </Section>
    </section>
  );
}

function ModeC({
  conversation,
  alert,
}: {
  conversation: ContextPanelProps["conversation"];
  alert: ContextPanelProps["alert"];
}) {
  return (
    <section className="border-t border-line-subtle px-4 py-4 space-y-4">
      <Section title="Resolution">
        <div className="flex items-center gap-2">
          <CheckCircle2 aria-hidden className="h-3.5 w-3.5 text-emerald-500" />
          <p className="text-xs text-fg-base">
            Resolved {conversation.resolvedAt ? formatRelativeTime(new Date(conversation.resolvedAt)) : ""}
          </p>
        </div>
        {conversation.resolutionSummary ? (
          <p className="mt-2 text-xs text-fg-base/70 whitespace-pre-wrap">
            {conversation.resolutionSummary}
          </p>
        ) : null}
      </Section>

      {alert ? (
        <Section title="Original alert (collapsed)">
          <p className="text-xs text-fg-base/60 line-clamp-2">{alert.title}</p>
        </Section>
      ) : null}
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-base/50">{title}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

interface QuickActionsProps {
  conversationId: string;
  state: "active" | "snoozed" | "resolved" | "archived";
  anchored: boolean;
}

function QuickActions({ conversationId, state, anchored }: QuickActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const dispatch = async (cmd: string) => {
    setBusy(cmd);
    try {
      await dispatchConversationSlash(conversationId, cmd);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-t border-line-subtle px-4 py-4 space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-base/50">Quick actions</p>
      <div className="grid grid-cols-2 gap-2">
        {state !== "snoozed" && state !== "resolved" ? (
          <ActionButton
            label="Snooze 2h"
            disabled={busy !== null}
            onClick={() => dispatch("/snooze 2h")}
            icon={<Clock className="h-3 w-3" />}
          />
        ) : null}
        {state === "snoozed" ? (
          <ActionButton
            label="Wake now"
            disabled={busy !== null}
            onClick={() => dispatch("/reopen")}
            icon={<ChevronRight className="h-3 w-3" />}
          />
        ) : null}
        {anchored && state !== "resolved" ? (
          <ActionButton
            label="Acknowledge"
            disabled={busy !== null}
            onClick={() => dispatch("/ack")}
            icon={<CheckCircle2 className="h-3 w-3" />}
          />
        ) : null}
        {state !== "resolved" ? (
          <ActionButton
            label="Resolve"
            disabled={busy !== null}
            onClick={() => dispatch("/resolve")}
            icon={<CheckCircle2 className="h-3 w-3" />}
          />
        ) : (
          <ActionButton
            label="Reopen"
            disabled={busy !== null}
            onClick={() => dispatch("/reopen")}
            icon={<ChevronRight className="h-3 w-3" />}
          />
        )}
        {anchored && state !== "resolved" ? (
          <ActionButton
            label="Escalate"
            disabled={busy !== null}
            onClick={() => dispatch("/escalate")}
            icon={<ChevronRight className="h-3 w-3" />}
          />
        ) : null}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line bg-surface-dim px-2.5 py-1.5 text-[11px] font-medium text-fg-base/80 transition-colors hover:text-fg-strong hover:border-line-medium disabled:opacity-50"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function VerifyBadgeLauncher({ conversationId }: { conversationId: string }) {
  const [state, setState] = useState<"idle" | "verifying" | "ok" | "tampered" | "unverifiable">("idle");
  const [error, setError] = useState<string | null>(null);

  const verify = async () => {
    setState("verifying");
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/verify`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        ok: boolean;
        firstBreakAt?: { reason: string } | null;
      };
      if (json.ok) setState("ok");
      else if (json.firstBreakAt?.reason === "missing_hash") setState("unverifiable");
      else setState("tampered");
    } catch (err) {
      setError(err instanceof Error ? err.message : "verify failed");
      setState("idle");
    }
  };

  const label =
    state === "verifying"    ? "verifying…" :
    state === "ok"            ? "✓ verified" :
    state === "tampered"      ? "✗ tampered" :
    state === "unverifiable"  ? "⚠ unverifiable" :
    "verify";
  const colorClass =
    state === "ok"            ? "text-emerald-600 dark:text-emerald-400" :
    state === "tampered"      ? "text-inari-accent" :
    state === "unverifiable"  ? "text-amber-600 dark:text-amber-400" :
    "text-fg-base/70";

  return (
    <button
      type="button"
      onClick={verify}
      disabled={state === "verifying"}
      title={error ?? "Verify witness chain"}
      data-testid="verify-badge"
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-line bg-surface-dim px-2 py-0.5 text-[10px] font-medium transition-colors hover:border-line-medium",
        colorClass,
      )}
    >
      <KeyRound aria-hidden className="h-3 w-3" />
      {label}
    </button>
  );
}
