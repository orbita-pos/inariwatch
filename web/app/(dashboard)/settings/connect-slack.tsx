"use client";

import { useState, useEffect, useTransition } from "react";
import { Hash, Plus, X, Loader2, Trash2, CheckCircle2, Settings } from "lucide-react";
import { saveSlackChannelMapping, removeSlackChannelMapping, disconnectSlack } from "./actions";

interface SlackInstallation {
  id: string;
  teamName: string;
  createdAt: string;
}

interface ChannelMapping {
  projectId: string;
  projectName: string;
  channelId: string | null;
  channelName: string | null;
}

// ── Dialog shell ──────────────────────────────────────────────────────────────

function Dialog({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-line bg-surface shadow-2xl">
        {children}
      </div>
    </div>
  );
}

// ── Install button (not connected) ────────────────────────────────────────────

export function ConnectSlackButton({ projects }: { projects?: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-fg-base transition-all"
      >
        <Plus className="h-3.5 w-3.5" />
        Install Slack Bot
      </button>

      <Dialog open={open} onClose={() => setOpen(false)}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#4A154B]">
              <Hash className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-sm font-semibold text-fg-strong">Install Slack Bot</span>
          </div>
          <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-fg-base transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-sm text-zinc-400 leading-relaxed">
            Connect InariWatch to your Slack workspace to receive alerts, trigger AI remediation, and manage incidents without leaving Slack.
          </p>
          <ul className="space-y-2">
            {[
              "Real-time alerts with AI diagnosis",
              "[Fix It] button triggers automated remediation in-thread",
              "Ask Inari via @mention in any channel",
              "Slash commands: /inari status, alerts, fix, oncall",
            ].map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm text-zinc-400">
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-500" />
                {f}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line">
          <button onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm text-zinc-500 hover:text-fg-base transition-colors">
            Cancel
          </button>
          <a
            href="/api/slack/oauth"
            className="inline-flex items-center gap-2 rounded-lg bg-[#4A154B] px-4 py-2 text-sm font-medium text-white hover:bg-[#5a1d5c] transition-colors"
          >
            <Hash className="h-3.5 w-3.5" />
            Add to Slack
          </a>
        </div>
      </Dialog>
    </>
  );
}

// ── Channel row (connected) ───────────────────────────────────────────────────

export function SlackChannelRow({
  installation,
  channelMappings,
  projects,
}: {
  installation: SlackInstallation;
  channelMappings: ChannelMapping[];
  projects: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [isPending, start] = useTransition();
  const [channelInputs, setChannelInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const m of channelMappings) {
      if (m.channelName) initial[m.projectId] = m.channelName;
    }
    setChannelInputs(initial);
  }, [channelMappings]);

  function handleSave(projectId: string) {
    const channelName = channelInputs[projectId]?.trim();
    if (!channelName) return;
    start(async () => { await saveSlackChannelMapping(projectId, installation.id, channelName); });
  }

  function handleRemove(projectId: string) {
    start(async () => {
      await removeSlackChannelMapping(projectId);
      setChannelInputs((prev) => { const next = { ...prev }; delete next[projectId]; return next; });
    });
  }

  function handleDisconnect() {
    if (!confirm("Disconnect Slack bot? Alerts will stop being sent to Slack.")) return;
    start(async () => { await disconnectSlack(); setOpen(false); });
  }

  const mappedCount = channelMappings.filter((m) => m.channelName).length;

  return (
    <>
      {/* Row — matches the other channel rows exactly */}
      <div className="flex items-center gap-3 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-medium bg-[#4A154B]/20 text-[#c77dff]">
          <Hash className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-fg-base">
            Slack
            <span className="ml-1.5 text-xs text-zinc-600">{installation.teamName}</span>
          </p>
          <p className="text-xs text-zinc-700">
            {mappedCount > 0 ? `${mappedCount} channel${mappedCount > 1 ? "s" : ""} mapped` : "No channels mapped yet"}
          </p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-2.5 py-1.5 text-[11px] font-medium text-zinc-500 hover:border-zinc-600 hover:text-fg-base transition-all"
        >
          <Settings className="h-3 w-3" />
          Manage
        </button>
      </div>

      {/* Manage dialog */}
      <Dialog open={open} onClose={() => setOpen(false)}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#4A154B]">
              <Hash className="h-3.5 w-3.5 text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold text-fg-strong">{installation.teamName}</p>
              <p className="text-[11px] text-green-500">Connected</p>
            </div>
          </div>
          <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-fg-base transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {projects.length > 0 && (
          <div className="px-5 py-4 space-y-3">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Channel mapping</p>
            <p className="text-xs text-zinc-600">Route alerts to specific Slack channels per project.</p>
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {projects.map((project) => {
                const existing = channelMappings.find((m) => m.projectId === project.id);
                return (
                  <div key={project.id} className="flex items-center gap-2">
                    <span className="w-36 shrink-0 truncate text-sm text-fg-base">{project.name}</span>
                    <div className="relative flex-1">
                      <Hash className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
                      <input
                        type="text"
                        value={channelInputs[project.id] || ""}
                        onChange={(e) => setChannelInputs((prev) => ({ ...prev, [project.id]: e.target.value }))}
                        placeholder="channel-name"
                        className="h-8 w-full rounded-lg border border-line bg-surface-inner pl-8 pr-3 text-sm text-fg-strong placeholder:text-zinc-600 outline-none focus:border-inari-accent/40 transition-colors"
                      />
                    </div>
                    <button
                      onClick={() => handleSave(project.id)}
                      disabled={isPending || !channelInputs[project.id]?.trim()}
                      className="h-8 px-3 rounded-lg bg-inari-accent/10 text-inari-accent text-xs font-medium hover:bg-inari-accent/20 disabled:opacity-40 transition-all shrink-0"
                    >
                      {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : existing ? "Update" : "Save"}
                    </button>
                    {existing && (
                      <button
                        onClick={() => handleRemove(project.id)}
                        className="h-8 px-2 rounded-lg text-zinc-500 hover:text-red-400 transition-colors shrink-0"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between px-5 py-4 border-t border-line">
          <button
            onClick={handleDisconnect}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-all"
          >
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            Disconnect
          </button>
          <button onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm text-zinc-500 hover:text-fg-base transition-colors">
            Done
          </button>
        </div>
      </Dialog>
    </>
  );
}
