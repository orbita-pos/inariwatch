"use client";

import { useState, useTransition } from "react";
import { Crown, UserPlus, Trash2, Globe, Lock } from "lucide-react";
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
    <section aria-labelledby="members-heading">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="members-heading" className="text-xs font-medium uppercase tracking-widest text-fg-base/70">
          Project access
        </h2>
      </div>

      <div className="rounded-xl border border-line bg-surface overflow-hidden divide-y divide-line-subtle">

        {/* Visibility toggle — admin only */}
        {isAdmin && isOrgProject && (
          <div className="flex items-center justify-between px-5 py-3.5">
            <div className="flex items-center gap-2.5">
              {isRestricted ? (
                <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              ) : (
                <Globe className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              )}
              <div>
                <p className="text-sm text-fg-base">
                  {isRestricted ? "Restricted" : "All workspace members"}
                </p>
                <p className="text-xs text-fg-base/70">
                  {isRestricted
                    ? "Only selected members can access this project"
                    : "Everyone in the workspace can see this project"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleVisibilityToggle}
              disabled={isPending}
              aria-label={isRestricted ? "Make project open to all workspace members" : "Restrict project to selected members"}
              className="rounded-lg border border-line-medium px-3 py-1.5 text-xs font-medium text-fg-base hover:border-line hover:text-fg-strong hover:bg-surface-inner transition-all disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
            >
              {isRestricted ? "Make open" : "Restrict"}
            </button>
          </div>
        )}

        {/* Visibility info — non-admin */}
        {!isAdmin && isOrgProject && (
          <div className="flex items-center gap-2.5 px-5 py-3.5">
            {isRestricted ? (
              <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            ) : (
              <Globe className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            )}
            <p className="text-sm text-fg-base/70">
              {isRestricted
                ? "This project is restricted to selected members"
                : "All workspace members can access this project"}
            </p>
          </div>
        )}

        {/* Owner row */}
        {owner && (
          <div className="flex items-center gap-3 px-5 py-3.5">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-inari-accent text-[11px] font-bold text-white"
              aria-hidden="true"
            >
              {(owner.name?.[0] ?? owner.email[0]).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-fg-base truncate">
                {owner.name ?? owner.email}
              </p>
              <p className="text-xs text-fg-base/70 truncate">{owner.email}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <Crown className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Owner</span>
            </div>
          </div>
        )}

        {/* Access members list (restricted mode) */}
        {isRestricted && accessMembers.length > 0 && (
          <ul className="divide-y divide-line-subtle">
            {accessMembers.map((member) => {
              const memberLabel = member.name ?? member.email;
              return (
                <li key={member.userId} className="flex items-center gap-3 px-5 py-3.5">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-dim text-[11px] font-bold text-fg-base/70"
                    aria-hidden="true"
                  >
                    {(member.name?.[0] ?? member.email[0]).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-fg-base truncate">
                      {member.name ?? member.email}
                    </p>
                    <p className="text-xs text-fg-base/70 truncate">{member.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isAdmin ? (
                      <select
                        value={member.role}
                        onChange={(e) => handleRoleChange(member.userId, e.target.value)}
                        disabled={isPending}
                        aria-label={`Role for ${memberLabel}`}
                        className="rounded-lg border border-line-medium bg-surface-dim px-2 py-1 text-xs text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 disabled:opacity-60"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="admin">Admin</option>
                      </select>
                    ) : (
                      <span className="text-xs text-fg-base/70 capitalize">
                        {member.role}
                      </span>
                    )}
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => handleRemoveAccess(member.userId)}
                        disabled={isPending}
                        aria-label={`Remove ${memberLabel} from project`}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/60 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Add member (restricted mode) */}
        {isRestricted && isAdmin && availableMembers.length > 0 && (
          <div className="px-5 py-3.5 space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
              Grant access
            </p>
            <ul className="space-y-1">
              {availableMembers.map((m) => {
                const label = m.name ?? m.email;
                return (
                  <li key={m.userId}>
                    <button
                      type="button"
                      onClick={() => handleAddAccess(m.userId)}
                      disabled={isPending}
                      aria-label={`Grant ${label} access to this project`}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-surface-inner transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
                    >
                      <div
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-dim text-[10px] font-bold text-fg-base/60"
                        aria-hidden="true"
                      >
                        {(m.name?.[0] ?? m.email[0]).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="truncate text-sm text-fg-base">
                          {m.name ?? m.email}
                        </p>
                        {m.name && (
                          <p className="truncate text-xs text-fg-base/70">{m.email}</p>
                        )}
                      </div>
                      <UserPlus className="h-3.5 w-3.5 text-fg-base/60" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Empty state for restricted + no members */}
        {isRestricted && accessMembers.length === 0 && (
          <div className="px-5 py-6 text-center">
            <p className="text-sm text-fg-base/70">
              No members have been granted access yet.{" "}
              {isAdmin && "Add workspace members above."}
            </p>
          </div>
        )}

        {/* Personal project info */}
        {!isOrgProject && (
          <div className="px-5 py-4 text-center">
            <p className="text-sm text-fg-base/70">
              This is a personal project. Move it to a workspace to manage team access.
            </p>
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </section>
  );
}
