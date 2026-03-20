"use client";

import { useState, useTransition } from "react";
import { Crown, UserPlus, Trash2, Globe, Lock, Check } from "lucide-react";
import { setProjectVisibility, addProjectAccess, removeProjectAccess, updateProjectMemberRole } from "./actions";

interface ProjectAccessSectionProps {
  projectId: string;
  isAdmin: boolean;
  isOrgProject: boolean;
  visibility: string;
  owner: { name: string | null; email: string } | null;
  accessMembers: {
    userId: string;
    name: string | null;
    email: string;
    role: string;
  }[];
  workspaceMembers: {
    userId: string;
    name: string | null;
    email: string;
    orgRole: string;
  }[];
}

export function ProjectAccessSection({
  projectId,
  isAdmin,
  isOrgProject,
  visibility,
  owner,
  accessMembers,
  workspaceMembers,
}: ProjectAccessSectionProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");

  const isRestricted = visibility === "restricted";

  // Workspace members who DON'T have explicit access yet
  const accessUserIds = new Set(accessMembers.map((m) => m.userId));
  const availableMembers = workspaceMembers.filter(
    (m) => !accessUserIds.has(m.userId) && m.email !== owner?.email
  );

  const handleVisibilityToggle = () => {
    setError("");
    startTransition(async () => {
      const result = await setProjectVisibility(
        projectId,
        isRestricted ? "all" : "restricted"
      );
      if (result.error) setError(result.error);
    });
  };

  const handleAddAccess = (userId: string) => {
    setError("");
    startTransition(async () => {
      const result = await addProjectAccess(projectId, userId);
      if (result.error) setError(result.error);
    });
  };

  const handleRemoveAccess = (userId: string) => {
    setError("");
    startTransition(async () => {
      const result = await removeProjectAccess(projectId, userId);
      if (result.error) setError(result.error);
    });
  };

  const handleRoleChange = (userId: string, role: string) => {
    setError("");
    startTransition(async () => {
      const result = await updateProjectMemberRole(projectId, userId, role);
      if (result.error) setError(result.error);
    });
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-500">
          Project access
        </h2>
      </div>

      <div className="rounded-xl border border-line bg-surface divide-y divide-line-subtle">

        {/* Visibility toggle */}
        {isAdmin && isOrgProject && (
          <div className="flex items-center justify-between px-5 py-3.5">
            <div className="flex items-center gap-2.5">
              {isRestricted ? (
                <Lock className="h-4 w-4 text-amber-500" />
              ) : (
                <Globe className="h-4 w-4 text-green-500" />
              )}
              <div>
                <p className="text-sm text-fg-base">
                  {isRestricted ? "Restricted" : "All workspace members"}
                </p>
                <p className="text-xs text-zinc-600">
                  {isRestricted
                    ? "Only selected members can access this project"
                    : "Everyone in the workspace can see this project"}
                </p>
              </div>
            </div>
            <button
              onClick={handleVisibilityToggle}
              disabled={isPending}
              className="rounded-lg border border-line-medium px-3 py-1.5 text-xs font-medium text-zinc-400 hover:border-zinc-600 hover:text-fg-base transition-all disabled:opacity-40"
            >
              {isRestricted ? "Make open" : "Restrict"}
            </button>
          </div>
        )}

        {/* Non-admin info */}
        {!isAdmin && isOrgProject && (
          <div className="flex items-center gap-2.5 px-5 py-3.5">
            {isRestricted ? (
              <Lock className="h-4 w-4 text-amber-500" />
            ) : (
              <Globe className="h-4 w-4 text-green-500" />
            )}
            <p className="text-sm text-zinc-500">
              {isRestricted
                ? "This project is restricted to selected members"
                : "All workspace members can access this project"}
            </p>
          </div>
        )}

        {/* Owner */}
        {owner && (
          <div className="flex items-center gap-3 px-5 py-3.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-inari-accent text-[11px] font-bold text-white">
              {(owner.name?.[0] ?? owner.email[0]).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-fg-base">
                {owner.name ?? owner.email}
              </p>
              <p className="text-xs text-zinc-600">{owner.email}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <Crown className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-xs font-medium text-amber-500">Owner</span>
            </div>
          </div>
        )}

        {/* Access members (when restricted) */}
        {isRestricted && accessMembers.map((member) => (
          <div key={member.userId} className="flex items-center gap-3 px-5 py-3.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-bold text-zinc-400">
              {(member.name?.[0] ?? member.email[0]).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-fg-base">
                {member.name ?? member.email}
              </p>
              <p className="text-xs text-zinc-600">{member.email}</p>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin ? (
                <select
                  value={member.role}
                  onChange={(e) => handleRoleChange(member.userId, e.target.value)}
                  disabled={isPending}
                  className="rounded-lg border border-line-medium bg-surface-dim px-2 py-1 text-xs text-zinc-400 focus:border-inari-accent/40 focus:outline-none"
                >
                  <option value="viewer">Viewer</option>
                  <option value="admin">Admin</option>
                </select>
              ) : (
                <span className="text-xs text-zinc-500 capitalize">
                  {member.role}
                </span>
              )}
              {isAdmin && (
                <button
                  onClick={() => handleRemoveAccess(member.userId)}
                  disabled={isPending}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors disabled:opacity-40"
                  title="Remove access"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}

        {/* Add member (restricted mode) */}
        {isRestricted && isAdmin && availableMembers.length > 0 && (
          <div className="px-5 py-3.5 space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
              Grant access
            </p>
            <div className="space-y-1">
              {availableMembers.map((m) => (
                <button
                  key={m.userId}
                  onClick={() => handleAddAccess(m.userId)}
                  disabled={isPending}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-surface-inner transition-colors disabled:opacity-40"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-zinc-500">
                    {(m.name?.[0] ?? m.email[0]).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <p className="truncate text-sm text-zinc-400">
                      {m.name ?? m.email}
                    </p>
                    {m.name && (
                      <p className="truncate text-xs text-zinc-600">{m.email}</p>
                    )}
                  </div>
                  <UserPlus className="h-3.5 w-3.5 text-zinc-600" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Empty state for restricted + no members */}
        {isRestricted && accessMembers.length === 0 && (
          <div className="px-5 py-6 text-center">
            <p className="text-sm text-zinc-500">
              No members have been granted access yet.{" "}
              {isAdmin && "Add workspace members above."}
            </p>
          </div>
        )}

        {/* Personal project info */}
        {!isOrgProject && (
          <div className="px-5 py-4 text-center">
            <p className="text-sm text-zinc-500">
              This is a personal project. Move it to a workspace to manage team access.
            </p>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-[12px] text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
