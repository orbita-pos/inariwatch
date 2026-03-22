import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, organizations, organizationMembers, users } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getActiveOrgId } from "@/lib/workspace";
import { redirect } from "next/navigation";
import { Building2, Crown, Trash2, Users } from "lucide-react";
import {
  updateWorkspaceName,
  removeMember,
  updateMemberRole,
  leaveWorkspace,
  deleteWorkspace,
} from "./actions";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Workspace settings" };

export default async function WorkspaceSettingsPage() {
  const session = await getServerSession(authOptions);
  const callerId = (session?.user as { id?: string })?.id;
  if (!callerId) redirect("/login");

  const activeOrgId = await getActiveOrgId();
  if (!activeOrgId) redirect("/settings");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, activeOrgId))
    .limit(1);

  if (!org) redirect("/settings");

  // Fetch all members with user info
  const memberRows = await db
    .select({
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      joinedAt: organizationMembers.joinedAt,
      name: users.name,
      email: users.email,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, activeOrgId));

  const currentMember = memberRows.find((m) => m.userId === callerId);
  if (!currentMember) redirect("/settings");

  const isOwner = org.ownerId === callerId;
  const isAdmin = currentMember.role === "admin";
  const canManage = isOwner || isAdmin;

  const createdDate = new Date(org.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="max-w-[680px] space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">
          Workspace settings
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Manage settings for <span className="font-medium text-zinc-400">{org.name}</span>.
        </p>
      </div>

      {/* ── Workspace ─────────────────────────────────────────────────────── */}
      <Section title="Workspace">
        <Row label="Name">
          {canManage ? (
            <form
              action={async (formData: FormData) => {
                "use server";
                await updateWorkspaceName(activeOrgId, formData.get("name") as string);
              }}
              className="flex items-center gap-2"
            >
              <input
                name="name"
                defaultValue={org.name}
                maxLength={40}
                className="flex-1 rounded-lg border border-line bg-surface-inner px-3 py-1.5 text-sm text-fg-base focus:outline-none focus:ring-1 focus:ring-inari-accent"
              />
              <button
                type="submit"
                className="rounded-lg bg-inari-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 transition-opacity"
              >
                Save
              </button>
            </form>
          ) : (
            <span className="text-sm text-fg-base">{org.name}</span>
          )}
        </Row>
        <Row label="Slug">
          <span className="font-mono text-sm text-zinc-500">{org.slug}</span>
        </Row>
        <Row label="Created">
          <span className="font-mono text-sm text-zinc-500">{createdDate}</span>
        </Row>
      </Section>

      {/* ── Members ───────────────────────────────────────────────────────── */}
      <Section title={`Members (${memberRows.length})`}>
        <div className="divide-y divide-line-subtle">
          {memberRows.map((member) => {
            const initial = (member.name ?? member.email ?? "?")[0].toUpperCase();
            const displayName = member.name ?? member.email ?? "Unknown";
            const isThisOwner = member.userId === org.ownerId;
            const isCurrentUser = member.userId === callerId;

            return (
              <div key={member.userId} className="flex items-center gap-3 py-3">
                {/* Avatar */}
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-inari-accent/10 text-inari-accent text-[13px] font-bold">
                  {initial}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm font-medium text-fg-base">{displayName}</p>
                    {isThisOwner && (
                      <Crown className="h-3 w-3 shrink-0 text-amber-500" />
                    )}
                    {isCurrentUser && (
                      <span className="text-[10px] text-zinc-500">(you)</span>
                    )}
                  </div>
                  {member.name && member.email && (
                    <p className="truncate text-xs text-zinc-500">{member.email}</p>
                  )}
                </div>

                {/* Role badge / dropdown */}
                <div className="flex items-center gap-2">
                  {isOwner && !isThisOwner ? (
                    <form
                      action={async (formData: FormData) => {
                        "use server";
                        await updateMemberRole(
                          activeOrgId,
                          member.userId,
                          formData.get("role") as "admin" | "member"
                        );
                      }}
                    >
                      <select
                        name="role"
                        defaultValue={member.role}
                        onChange={undefined}
                        className="rounded-md border border-line bg-surface-inner px-2 py-1 text-xs text-fg-base focus:outline-none focus:ring-1 focus:ring-inari-accent"
                      >
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </select>
                      <button
                        type="submit"
                        className="ml-1.5 rounded-md border border-line bg-surface-inner px-2 py-1 text-xs text-fg-base hover:bg-surface-dim transition-colors"
                      >
                        Set
                      </button>
                    </form>
                  ) : (
                    <RoleBadge role={isThisOwner ? "owner" : member.role} />
                  )}

                  {/* Remove button — owner/admin can remove non-owners */}
                  {canManage && !isThisOwner && !isCurrentUser && (
                    <form
                      action={async () => {
                        "use server";
                        await removeMember(activeOrgId, member.userId);
                      }}
                    >
                      <button
                        type="submit"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-red-500/10 hover:text-red-500 transition-colors"
                        title="Remove member"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ── Danger zone ───────────────────────────────────────────────────── */}
      <Section title="Danger zone">
        {isOwner ? (
          <div className="flex items-center justify-between rounded-lg border border-red-950/40 bg-red-950/10 px-4 py-3.5 my-1">
            <div>
              <p className="text-sm font-medium text-fg-base">Delete workspace</p>
              <p className="mt-0.5 text-sm text-zinc-500">
                Permanently delete <span className="font-medium text-zinc-400">{org.name}</span> and all its data.
              </p>
            </div>
            <form
              action={async () => {
                "use server";
                await deleteWorkspace(activeOrgId);
                redirect("/dashboard");
              }}
            >
              <button
                type="submit"
                className="rounded-lg border border-red-900/20 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-500/10 transition-colors"
              >
                Delete
              </button>
            </form>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-lg border border-line bg-surface-dim px-4 py-3.5 my-1">
            <div>
              <p className="text-sm font-medium text-fg-base">Leave workspace</p>
              <p className="mt-0.5 text-sm text-zinc-500">
                Remove yourself from <span className="font-medium text-zinc-400">{org.name}</span>.
              </p>
            </div>
            <form
              action={async () => {
                "use server";
                await leaveWorkspace(activeOrgId);
                redirect("/dashboard");
              }}
            >
              <button
                type="submit"
                className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-fg-base hover:bg-surface-inner transition-colors"
              >
                Leave
              </button>
            </form>
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-widest text-zinc-600">{title}</h2>
      <div className="overflow-hidden rounded-xl border border-line bg-surface px-5 divide-y divide-line-subtle">
        {children}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <span className="w-28 shrink-0 text-sm text-zinc-500">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const styles: Record<string, string> = {
    owner: "bg-amber-500/10 text-amber-600 border-amber-500/20",
    admin: "bg-inari-accent/10 text-inari-accent border-inari-accent/20",
    member: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
  };
  const labels: Record<string, string> = {
    owner: "Owner",
    admin: "Admin",
    member: "Member",
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${styles[role] ?? styles.member}`}
    >
      {labels[role] ?? role}
    </span>
  );
}
