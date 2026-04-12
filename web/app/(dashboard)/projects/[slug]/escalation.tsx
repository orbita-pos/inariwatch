"use client";

import { useState, useTransition, useId } from "react";
import { Plus, Trash2, Bell, Power } from "lucide-react";
import {
  createEscalationRule,
  deleteEscalationRule,
  toggleEscalationRule,
} from "./actions";

interface EscalationRule {
  id:          string;
  targetType:  string;
  channelId:   string | null;
  delaySec:    number;
  minSeverity: string;
  isActive:    boolean;
  createdAt:   Date;
}

interface Channel {
  id:     string;
  type:   string;
  config: Record<string, string>;
}

interface EscalationSectionProps {
  projectId: string;
  isAdmin:   boolean;
  rules:     EscalationRule[];
  channels:  Channel[];
}

const DELAY_OPTIONS = [
  { label: "15 minutes", value: 900 },
  { label: "30 minutes", value: 1800 },
  { label: "1 hour",     value: 3600 },
  { label: "2 hours",    value: 7200 },
];

const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/25",
  warning:  "bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/25",
  info:     "bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/25",
};

function formatDelay(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} hr`;
}

function channelLabel(ch: Channel): string {
  if (ch.type === "email")    return `Email (${ch.config.email ?? "..."})`;
  if (ch.type === "telegram") return `Telegram (${ch.config.chat_id ?? "..."})`;
  if (ch.type === "slack")    return "Slack";
  return ch.type;
}

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        SEVERITY_BADGE[severity] ?? "bg-surface-dim text-fg-base/70"
      }`}
    >
      {severity}
    </span>
  );
}

export function EscalationSection({
  projectId,
  isAdmin,
  rules,
  channels,
}: EscalationSectionProps) {
  const [showForm, setShowForm]       = useState(false);
  const [targetValue, setTargetValue] = useState("on_call_primary");
  const [delaySec, setDelaySec]       = useState(1800);
  const [minSeverity, setMinSeverity] = useState("critical");
  const [error, setError]             = useState("");
  const [isPending, startTransition]  = useTransition();

  const uid       = useId();
  const targetId  = `${uid}-target`;
  const delayId   = `${uid}-delay`;
  const minSevId  = `${uid}-min-sev`;
  const errorId   = `${uid}-error`;

  const channelMap = new Map(channels.map((ch) => [ch.id, ch]));

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      let targetType   = "channel";
      let channelIdStr: string | null = targetValue;

      if (
        targetValue === "on_call_primary" ||
        targetValue === "on_call_secondary" ||
        targetValue === "all_org_admins"
      ) {
        targetType   = targetValue;
        channelIdStr = null;
      }

      const result = await createEscalationRule(
        projectId,
        targetType,
        channelIdStr,
        delaySec,
        minSeverity
      );
      if (result.error) {
        setError(result.error);
      } else {
        setShowForm(false);
        setTargetValue("on_call_primary");
        setDelaySec(1800);
      }
    });
  };

  const handleDelete = (ruleId: string) => {
    startTransition(async () => {
      await deleteEscalationRule(projectId, ruleId);
    });
  };

  const handleToggle = (ruleId: string, isActive: boolean) => {
    startTransition(async () => {
      await toggleEscalationRule(projectId, ruleId, !isActive);
    });
  };

  return (
    <section aria-labelledby="escalation-heading">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="escalation-heading" className="text-xs font-medium uppercase tracking-widest text-fg-base/70">
          Escalation rules
        </h2>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setShowForm(!showForm)}
            aria-expanded={showForm}
            aria-controls="escalation-form"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-fg-base hover:border-line hover:text-fg-strong hover:bg-surface transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add rule
          </button>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface overflow-hidden">
        {rules.length > 0 ? (
          <ul className="divide-y divide-line-subtle">
            {rules.map((rule) => {
              const ch = rule.channelId ? channelMap.get(rule.channelId) : undefined;

              let targetLabel = "Unknown target";
              if (rule.targetType === "on_call_primary")   targetLabel = "Primary On-Call";
              else if (rule.targetType === "on_call_secondary") targetLabel = "Secondary On-Call";
              else if (rule.targetType === "all_org_admins")    targetLabel = "All org admins";
              else if (rule.targetType === "channel")           targetLabel = ch ? channelLabel(ch) : "Unknown channel";

              return (
                <li
                  key={rule.id}
                  className={`flex items-center gap-3 px-5 py-3.5 ${!rule.isActive ? "opacity-40" : ""}`}
                >
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      rule.isActive
                        ? "bg-inari-accent/10 text-inari-accent"
                        : "bg-surface-dim text-fg-base/60"
                    }`}
                    aria-hidden="true"
                  >
                    <Bell className="h-3.5 w-3.5" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm text-fg-base truncate">{targetLabel}</p>
                      <SeverityBadge severity={rule.minSeverity} />
                    </div>
                    <p className="text-xs text-fg-base/70">
                      Escalate after {formatDelay(rule.delaySec)} if unresolved
                    </p>
                  </div>

                  {isAdmin && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleToggle(rule.id, rule.isActive)}
                        disabled={isPending}
                        aria-label={rule.isActive ? `Disable rule for ${targetLabel}` : `Enable rule for ${targetLabel}`}
                        aria-pressed={rule.isActive}
                        className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 ${
                          rule.isActive
                            ? "text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                            : "text-fg-base/60 hover:text-fg-base hover:bg-surface-inner"
                        }`}
                      >
                        <Power className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(rule.id)}
                        disabled={isPending}
                        aria-label={`Delete escalation rule for ${targetLabel}`}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/60 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="px-5 py-6 text-center">
            <p className="text-sm text-fg-base/70">
              {channels.length === 0
                ? "Add a notification channel in settings to create channel escalation rules, or route to On-Call directly."
                : "No escalation rules. Create one to automatically route unresolved alerts."}
            </p>
          </div>
        )}
      </div>

      {showForm && isAdmin && (
        <form
          id="escalation-form"
          onSubmit={handleCreate}
          aria-labelledby="escalation-form-heading"
          className="mt-3 rounded-xl border border-line bg-surface px-5 py-4 space-y-3"
        >
          <h3 id="escalation-form-heading" className="sr-only">Create escalation rule</h3>

          <div className="space-y-1.5">
            <label htmlFor={targetId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
              Notification target
            </label>
            <select
              id={targetId}
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              disabled={isPending}
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
            >
              <option value="on_call_primary">Primary On-Call</option>
              <option value="on_call_secondary">Secondary On-Call</option>
              <option value="all_org_admins">All org admins</option>
              {channels.length > 0 && (
                <optgroup label="Notification Channels">
                  {channels.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {channelLabel(ch)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor={delayId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                Delay
              </label>
              <select
                id={delayId}
                value={delaySec}
                onChange={(e) => setDelaySec(Number(e.target.value))}
                disabled={isPending}
                className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
              >
                {DELAY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={minSevId} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                Min severity
              </label>
              <select
                id={minSevId}
                value={minSeverity}
                onChange={(e) => setMinSeverity(e.target.value)}
                disabled={isPending}
                className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
              >
                <option value="critical">Critical only</option>
                <option value="warning">Warning and above</option>
                <option value="info">All severities</option>
              </select>
            </div>
          </div>

          {error && (
            <p
              id={errorId}
              role="alert"
              className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-700 dark:text-red-400"
            >
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setShowForm(false); setError(""); }}
              disabled={isPending}
              className="flex-1 rounded-lg border border-line-medium px-3 py-2 text-sm text-fg-base hover:text-fg-strong hover:border-line transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              aria-busy={isPending}
              className="flex-1 rounded-lg bg-inari-accent px-3 py-2 text-sm font-medium text-white hover:bg-inari-accent/90 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
            >
              {isPending ? "Creating…" : "Create rule"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
