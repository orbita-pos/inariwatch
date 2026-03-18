"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Settings, UserPlus, Zap, Plus, Building2 } from "lucide-react";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";
import { InviteMembersDialog } from "./invite-members-dialog";
import { switchWorkspace } from "./switch-workspace-action";

const PLAN_LABEL: Record<string, string> = {
  free: "Free plan",
  pro:  "Pro plan",
};

const PLAN_COLOR: Record<string, string> = {
  free: "text-zinc-500",
  pro:  "text-inari-accent",
};

const ROLE_LABEL: Record<string, string> = {
  owner:  "Owner",
  admin:  "Admin",
  member: "Member",
};

export interface OrgItem {
  id:        string;
  name:      string;
  slug:      string;
  ownerId:   string;
  avatarUrl: string | null;
  role:      string;
}

interface WorkspaceSwitcherProps {
  userName:       string;
  userEmail:      string;
  plan:           "free" | "pro";
  organizations:  OrgItem[];
  activeOrgId:    string | null;
}

export function WorkspaceSwitcher({ userName, userEmail, plan, organizations, activeOrgId }: WorkspaceSwitcherProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteOrg, setInviteOrg] = useState<OrgItem | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const personalName = userName !== userEmail ? `${userName.split(" ")[0]}'s workspace` : "My workspace";

  const activeOrg = organizations.find((o) => o.id === activeOrgId) ?? null;
  const activeName = activeOrg?.name ?? personalName;

  function handleInvite(org: OrgItem) {
    setInviteOrg(org);
    setMenuOpen(false);
    setInviteOpen(true);
  }

  function handleCreateWorkspace() {
    setMenuOpen(false);
    setCreateOpen(true);
  }

  return (
    <>
      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <button className="flex h-14 w-full shrink-0 items-center gap-2.5 border-b border-line px-4 hover:bg-surface-inner transition-colors focus:outline-none group">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md overflow-hidden">
              <Image
                src="/logo-inari/favicon-96x96.png"
                alt="InariWatch"
                width={28}
                height={28}
              />
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-sm font-semibold text-fg-strong leading-tight">
                {activeName}
              </p>
              <p className={`text-[11px] leading-tight ${PLAN_COLOR[plan]}`}>
                {PLAN_LABEL[plan]}
              </p>
            </div>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500 group-hover:text-fg-base transition-colors" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={0}
            className="z-50 w-[240px] rounded-xl border border-line bg-surface shadow-lg shadow-black/10 dark:shadow-black/40 py-1.5"
          >
            {/* Personal workspace */}
            <div className="px-1.5 mb-1">
              <button
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-surface-inner transition-colors"
                onClick={() => {
                  startTransition(async () => {
                    await switchWorkspace(null);
                    router.refresh();
                    setMenuOpen(false);
                  });
                }}
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md overflow-hidden">
                  <Image src="/logo-inari/favicon-96x96.png" alt="" width={28} height={28} />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-fg-strong">{personalName}</p>
                  <p className="text-[11px] text-zinc-500 truncate">{userEmail}</p>
                </div>
                {!activeOrg && <Check className="h-3.5 w-3.5 shrink-0 text-inari-accent" />}
              </button>
            </div>

            {/* Organization workspaces */}
            {organizations.length > 0 && (
              <>
                <DropdownMenu.Separator className="h-px bg-line my-1" />
                <p className="px-3 py-1.5 text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                  Workspaces
                </p>
                <div className="px-1.5">
                  {organizations.map((org) => (
                    <button
                      key={org.id}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-surface-inner transition-colors"
                      onClick={() => {
                        startTransition(async () => {
                          await switchWorkspace(org.id);
                          router.refresh();
                          setMenuOpen(false);
                        });
                      }}
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-inari-accent/10 text-inari-accent">
                        <Building2 className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1 text-left">
                        <p className="truncate text-sm font-medium text-fg-strong">{org.name}</p>
                        <p className="text-[11px] text-zinc-500">{ROLE_LABEL[org.role] ?? org.role}</p>
                      </div>
                      {activeOrg?.id === org.id && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-inari-accent" />
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}

            <DropdownMenu.Separator className="h-px bg-line my-1" />

            {/* Actions */}
            <DropdownMenu.Item asChild>
              <Link
                href="/settings"
                className="flex items-center gap-2.5 px-3 py-2 text-sm text-fg-base hover:text-fg-strong hover:bg-surface-inner rounded-lg mx-1 cursor-pointer outline-none transition-colors"
              >
                <Settings className="h-3.5 w-3.5 text-zinc-500" />
                Workspace settings
              </Link>
            </DropdownMenu.Item>

            {/* Invite members — show for each org user can manage */}
            {organizations.filter((o) => o.role === "owner" || o.role === "admin").map((org) => (
              <DropdownMenu.Item
                key={`invite-${org.id}`}
                onSelect={() => handleInvite(org)}
                className="flex items-center gap-2.5 px-3 py-2 text-sm text-fg-base hover:text-fg-strong hover:bg-surface-inner rounded-lg mx-1 cursor-pointer outline-none transition-colors"
              >
                <UserPlus className="h-3.5 w-3.5 text-zinc-500" />
                Invite to {org.name}
              </DropdownMenu.Item>
            ))}

            {plan === "free" && (
              <>
                <DropdownMenu.Separator className="h-px bg-line my-1" />
                <DropdownMenu.Item asChild>
                  <Link
                    href="/settings"
                    className="flex items-center gap-2.5 px-3 py-2 text-sm text-inari-accent hover:bg-inari-accent/5 rounded-lg mx-1 cursor-pointer outline-none transition-colors font-medium"
                  >
                    <Zap className="h-3.5 w-3.5" />
                    Upgrade to Pro
                  </Link>
                </DropdownMenu.Item>
              </>
            )}

            <DropdownMenu.Separator className="h-px bg-line my-1" />

            <DropdownMenu.Item
              onSelect={handleCreateWorkspace}
              className="flex items-center gap-2.5 px-3 py-2 text-sm text-fg-base hover:text-fg-strong hover:bg-surface-inner rounded-lg mx-1 cursor-pointer outline-none transition-colors"
            >
              <Plus className="h-3.5 w-3.5 text-zinc-500" />
              Create workspace
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Dialogs */}
      <CreateWorkspaceDialog open={createOpen} onClose={() => setCreateOpen(false)} />

      {inviteOrg && (
        <InviteMembersDialog
          open={inviteOpen}
          onClose={() => { setInviteOpen(false); setInviteOrg(null); }}
          organizationId={inviteOrg.id}
          orgName={inviteOrg.name}
        />
      )}
    </>
  );
}
