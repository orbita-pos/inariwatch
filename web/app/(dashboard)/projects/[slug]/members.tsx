"use client";

import { useState, useTransition } from "react";
import { Crown, UserPlus, Trash2, Clock, Mail } from "lucide-react";
import { inviteMember, removeMember, updateMemberRole, cancelInvite } from "./actions";

interface MembersSectionProps {
  projectId: string;
  isAdmin: boolean;
  owner: { name: string | null; email: string } | null;
  members: {
    id: string;
    name: string | null;
    email: string;
    role: string;
    acceptedAt: Date | null;
  }[];
  pendingInvites: {
    id: string;
    email: string;
    role: string;
    createdAt: Date;
  }[];
}

export function MembersSection({
  projectId,
  isAdmin,
  owner,
  members,
  pendingInvites,
}: MembersSectionProps) {
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "admin">("viewer");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await inviteMember(projectId, email, role);
      if (result.error) {
        setError(result.error);
      } else {
        setEmail("");
        setShowInvite(false);
      }
    });
  };

  const handleRemove = (memberId: string) => {
    startTransition(async () => {
      await removeMember(projectId, memberId);
    });
  };

  const handleRoleChange = (memberId: string, newRole: string) => {
    startTransition(async () => {
      await updateMemberRole(projectId, memberId, newRole);
    });
  };

  const handleCancelInvite = (inviteId: string) => {
    startTransition(async () => {
      await cancelInvite(projectId, inviteId);
    });
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-500">
          Team members
        </h2>
        {isAdmin && (
          <button
            onClick={() => setShowInvite(!showInvite)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#222] bg-transparent px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-all"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Invite
          </button>
        )}
      </div>

      <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] divide-y divide-[#131313]">
        {/* Owner */}
        {owner && (
          <div className="flex items-center gap-3 px-5 py-3.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-inari-accent text-[11px] font-bold text-white">
              {(owner.name?.[0] ?? owner.email[0]).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-zinc-300">
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

        {/* Members */}
        {members.map((member) => (
          <div key={member.id} className="flex items-center gap-3 px-5 py-3.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-bold text-zinc-400">
              {(member.name?.[0] ?? member.email[0]).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-zinc-300">
                {member.name ?? member.email}
              </p>
              <p className="text-xs text-zinc-600">{member.email}</p>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin ? (
                <select
                  value={member.role}
                  onChange={(e) => handleRoleChange(member.id, e.target.value)}
                  disabled={isPending}
                  className="rounded-lg border border-[#222] bg-[#111] px-2 py-1 text-xs text-zinc-400 focus:border-inari-accent/40 focus:outline-none"
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
                  onClick={() => handleRemove(member.id)}
                  disabled={isPending}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors disabled:opacity-40"
                  title="Remove member"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}

        {/* Pending invites */}
        {pendingInvites.map((invite) => (
          <div
            key={invite.id}
            className="flex items-center gap-3 px-5 py-3.5 opacity-60"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-700 text-zinc-600">
              <Mail className="h-3.5 w-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-zinc-400">{invite.email}</p>
              <p className="flex items-center gap-1 text-xs text-zinc-600">
                <Clock className="h-3 w-3" />
                Pending invite &middot; {invite.role}
              </p>
            </div>
            {isAdmin && (
              <button
                onClick={() => handleCancelInvite(invite.id)}
                disabled={isPending}
                className="text-xs text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
            )}
          </div>
        ))}

        {/* Empty state */}
        {members.length === 0 && pendingInvites.length === 0 && (
          <div className="px-5 py-6 text-center">
            <p className="text-sm text-zinc-500">
              No team members yet. Invite someone to collaborate.
            </p>
          </div>
        )}
      </div>

      {/* Invite form */}
      {showInvite && isAdmin && (
        <form
          onSubmit={handleInvite}
          className="mt-3 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-5 py-4 space-y-3"
        >
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
              Email address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              required
              className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2 text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
              Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "viewer" | "admin")}
              className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2 text-sm text-zinc-100 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
            >
              <option value="viewer">Viewer — can see alerts and integrations</option>
              <option value="admin">Admin — can manage integrations and invite members</option>
            </select>
          </div>
          {error && (
            <p className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-[12px] text-red-400">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowInvite(false)}
              className="flex-1 rounded-lg border border-[#222] px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 rounded-lg bg-inari-accent px-3 py-2 text-sm font-medium text-white hover:bg-[#6D28D9] transition-colors disabled:opacity-40"
            >
              {isPending ? "Sending..." : "Send invite"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
