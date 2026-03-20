"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, Bell, Power } from "lucide-react";
import {
  createEscalationRule,
  deleteEscalationRule,
  toggleEscalationRule,
} from "./actions";

interface EscalationRule {
  id: string;
  targetType: string;
  channelId: string | null;
  delaySec: number;
  minSeverity: string;
  isActive: boolean;
  createdAt: Date;
}

interface Channel {
  id: string;
  type: string;
  config: Record<string, string>;
}

interface EscalationSectionProps {
  projectId: string;
  isAdmin: boolean;
  rules: EscalationRule[];
  channels: Channel[];
}

const DELAY_OPTIONS = [
  { label: "15 minutes", value: 900 },
  { label: "30 minutes", value: 1800 },
  { label: "1 hour", value: 3600 },
  { label: "2 hours", value: 7200 },
];

function formatDelay(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} hr`;
}

function channelLabel(ch: Channel): string {
  const config = ch.config as Record<string, string>;
  if (ch.type === "email") return `Email (${config.email ?? "..."})`;
  if (ch.type === "telegram") return `Telegram (${config.chat_id ?? "..."})`;
  if (ch.type === "slack") return `Slack`;
  return ch.type;
}

function severityBadge(severity: string) {
  const colors: Record<string, string> = {
    critical: "bg-red-500/10 text-red-400",
    warning: "bg-amber-500/10 text-amber-400",
    info: "bg-blue-500/10 text-blue-400",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        colors[severity] ?? "bg-zinc-800 text-zinc-400"
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
  const [showForm, setShowForm] = useState(false);
  const [targetValue, setTargetValue] = useState("on_call_primary");
  const [delaySec, setDelaySec] = useState(1800);
  const [minSeverity, setMinSeverity] = useState("critical");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      let targetType = "channel";
      let channelIdStr: string | null = targetValue;
      
      if (targetValue === "on_call_primary" || targetValue === "on_call_secondary") {
        targetType = targetValue;
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

  // Map channel IDs to labels
  const channelMap = new Map(channels.map((ch) => [ch.id, ch]));

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-500">
          Escalation rules
        </h2>
        {isAdmin && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-fg-base transition-all"
          >
            <Plus className="h-3.5 w-3.5" />
            Add rule
          </button>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface divide-y divide-line-subtle">
        {rules.map((rule) => {
          const ch = rule.channelId ? channelMap.get(rule.channelId) : undefined;
          
          let targetLabel = "Unknown target";
          if (rule.targetType === "on_call_primary") targetLabel = "Primary On-Call";
          else if (rule.targetType === "on_call_secondary") targetLabel = "Secondary On-Call";
          else if (rule.targetType === "channel") targetLabel = ch ? channelLabel(ch) : "Unknown channel";

          return (
            <div
              key={rule.id}
              className={`flex items-center gap-3 px-5 py-3.5 ${
                !rule.isActive ? "opacity-40" : ""
              }`}
            >
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  rule.isActive
                    ? "bg-inari-accent/10 text-inari-accent"
                    : "bg-zinc-800 text-zinc-500"
                }`}
              >
                <Bell className="h-3.5 w-3.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm text-fg-base truncate">
                    {targetLabel}
                  </p>
                  {severityBadge(rule.minSeverity)}
                </div>
                <p className="text-xs text-zinc-600">
                  Escalate after {formatDelay(rule.delaySec)} if unresolved
                </p>
              </div>
              {isAdmin && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleToggle(rule.id, rule.isActive)}
                    disabled={isPending}
                    className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
                      rule.isActive
                        ? "text-emerald-400 hover:bg-emerald-400/[0.06]"
                        : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-400/[0.06]"
                    }`}
                    title={rule.isActive ? "Disable rule" : "Enable rule"}
                  >
                    <Power className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(rule.id)}
                    disabled={isPending}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors disabled:opacity-40"
                    title="Delete rule"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {rules.length === 0 && (
          <div className="px-5 py-6 text-center">
            <p className="text-sm text-zinc-500">
              {channels.length === 0
                ? "Add a notification channel in settings to create channel escalation rules, or route to On-Call directly."
                : "No escalation rules. Create one to automatically route unresolved alerts."}
            </p>
          </div>
        )}
      </div>

      {showForm && isAdmin && (
        <form
          onSubmit={handleCreate}
          className="mt-3 rounded-xl border border-line bg-surface px-5 py-4 space-y-3"
        >
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
              Notification target
            </label>
            <select
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
            >
              <option value="on_call_primary">Primary On-Call</option>
              <option value="on_call_secondary">Secondary On-Call</option>
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
              <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                Delay
              </label>
              <select
                value={delaySec}
                onChange={(e) => setDelaySec(Number(e.target.value))}
                className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
              >
                {DELAY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                Min severity
              </label>
              <select
                value={minSeverity}
                onChange={(e) => setMinSeverity(e.target.value)}
                className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
              >
                <option value="critical">Critical only</option>
                <option value="warning">Warning and above</option>
                <option value="info">All severities</option>
              </select>
            </div>
          </div>
          {error && (
            <p className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-[12px] text-red-400">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="flex-1 rounded-lg border border-line-medium px-3 py-2 text-sm text-zinc-400 hover:text-fg-base transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 rounded-lg bg-inari-accent px-3 py-2 text-sm font-medium text-white hover:bg-[#6D28D9] transition-colors disabled:opacity-40"
            >
              {isPending ? "Creating..." : "Create rule"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
