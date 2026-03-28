"use client";

import { useState, useEffect, useTransition } from "react";
import { Hash, Plus, X, Loader2, Link2, Trash2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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

export function ConnectSlackButton({
  installation,
  channelMappings,
  projects,
}: {
  installation?: SlackInstallation | null;
  channelMappings?: ChannelMapping[];
  projects?: { id: string; name: string }[];
}) {
  // Not installed — show Install button
  if (!installation) {
    return (
      <a
        href="/api/slack/oauth"
        className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-fg-base transition-all"
      >
        <Plus className="h-3.5 w-3.5" />
        Install Slack Bot
      </a>
    );
  }

  // Installed — show workspace info + channel mapping
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-green-400" />
          <span className="text-sm text-fg-base">
            Connected to <span className="font-medium text-fg-strong">{installation.teamName}</span>
          </span>
        </div>
        <DisconnectButton />
      </div>

      {projects && projects.length > 0 && (
        <ChannelMappingTable
          installationId={installation.id}
          projects={projects}
          mappings={channelMappings || []}
        />
      )}
    </div>
  );
}

function DisconnectButton() {
  const [isPending, start] = useTransition();

  return (
    <button
      onClick={() => {
        if (confirm("Disconnect Slack bot? Alerts will stop being sent to Slack.")) {
          start(async () => {
            await disconnectSlack();
          });
        }
      }}
      disabled={isPending}
      className="inline-flex items-center gap-1 rounded-lg border border-red-500/20 bg-red-500/5 px-2 py-1 text-[11px] font-medium text-red-400 hover:bg-red-500/10 transition-all"
    >
      {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
      Disconnect
    </button>
  );
}

function ChannelMappingTable({
  installationId,
  projects,
  mappings,
}: {
  installationId: string;
  projects: { id: string; name: string }[];
  mappings: ChannelMapping[];
}) {
  const [isPending, start] = useTransition();
  const [channelInputs, setChannelInputs] = useState<Record<string, string>>({});

  // Initialize from existing mappings
  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const m of mappings) {
      if (m.channelName) initial[m.projectId] = m.channelName;
    }
    setChannelInputs(initial);
  }, [mappings]);

  function handleSave(projectId: string) {
    const channelName = channelInputs[projectId]?.trim();
    if (!channelName) return;

    start(async () => {
      await saveSlackChannelMapping(projectId, installationId, channelName);
    });
  }

  function handleRemove(projectId: string) {
    start(async () => {
      await removeSlackChannelMapping(projectId);
      setChannelInputs((prev) => {
        const next = { ...prev };
        delete next[projectId];
        return next;
      });
    });
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Channel Mapping</p>
      <p className="text-xs text-zinc-500">Choose which Slack channel receives alerts for each project.</p>

      <div className="space-y-2 mt-3">
        {projects.map((project) => {
          const existing = mappings.find((m) => m.projectId === project.id);
          return (
            <div key={project.id} className="flex items-center gap-2">
              <span className="text-sm text-fg-base w-40 truncate">{project.name}</span>
              <div className="flex-1 flex items-center gap-2">
                <div className="relative flex-1">
                  <Hash className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
                  <input
                    type="text"
                    value={channelInputs[project.id] || ""}
                    onChange={(e) =>
                      setChannelInputs((prev) => ({ ...prev, [project.id]: e.target.value }))
                    }
                    placeholder="channel-name"
                    className="h-8 w-full rounded-lg border border-line bg-surface-inner pl-8 pr-3 text-sm text-fg-strong placeholder:text-zinc-600 outline-none focus:border-inari-accent/40 transition-colors"
                  />
                </div>
                <button
                  onClick={() => handleSave(project.id)}
                  disabled={isPending || !channelInputs[project.id]?.trim()}
                  className="h-8 px-3 rounded-lg bg-inari-accent/10 text-inari-accent text-xs font-medium hover:bg-inari-accent/20 disabled:opacity-40 transition-all"
                >
                  {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : existing ? "Update" : "Save"}
                </button>
                {existing && (
                  <button
                    onClick={() => handleRemove(project.id)}
                    className="h-8 px-2 rounded-lg text-zinc-500 hover:text-red-400 transition-colors"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
