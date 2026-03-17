"use client";

import Link from "next/link";
import Image from "next/image";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Settings, UserPlus, Zap, Plus } from "lucide-react";

const PLAN_LABEL: Record<string, string> = {
  free:  "Free plan",
  pro:   "Pro plan",
  team:  "Team plan",
};

const PLAN_COLOR: Record<string, string> = {
  free:  "text-zinc-500",
  pro:   "text-inari-accent",
  team:  "text-emerald-500",
};

interface WorkspaceSwitcherProps {
  userName:  string;
  userEmail: string;
  plan:      "free" | "pro" | "team";
}

export function WorkspaceSwitcher({ userName, userEmail, plan }: WorkspaceSwitcherProps) {
  const workspaceName = userName !== userEmail ? `${userName.split(" ")[0]}'s workspace` : "My workspace";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex h-14 w-full shrink-0 items-center gap-2.5 border-b border-line px-4 hover:bg-surface-inner transition-colors focus:outline-none group">
          {/* Logo mark */}
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md overflow-hidden">
            <Image
              src="/logo-inari/favicon-96x96.png"
              alt="InariWatch"
              width={28}
              height={28}
            />
          </div>

          {/* Workspace name + plan */}
          <div className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-semibold text-fg-strong leading-tight">
              {workspaceName}
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
          className="z-50 w-[220px] rounded-xl border border-line bg-surface shadow-lg shadow-black/10 dark:shadow-black/40 py-1.5 animate-fade-up"
        >
          {/* Current workspace */}
          <div className="px-3 py-2 mb-1">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md overflow-hidden">
                <Image src="/logo-inari/favicon-96x96.png" alt="" width={28} height={28} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg-strong">{workspaceName}</p>
                <p className="text-[11px] text-zinc-500 truncate">{userEmail}</p>
              </div>
              <Check className="h-3.5 w-3.5 shrink-0 text-inari-accent" />
            </div>
          </div>

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

          <DropdownMenu.Item
            disabled={plan === "free" || plan === "pro"}
            className={`flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg mx-1 outline-none transition-colors ${
              plan === "team"
                ? "text-fg-base hover:text-fg-strong hover:bg-surface-inner cursor-pointer"
                : "text-zinc-600 cursor-not-allowed"
            }`}
          >
            <UserPlus className="h-3.5 w-3.5 text-zinc-500" />
            Invite members
            {plan !== "team" && (
              <span className="ml-auto text-[10px] font-medium text-zinc-600 bg-surface-inner px-1.5 py-0.5 rounded">
                Team
              </span>
            )}
          </DropdownMenu.Item>

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
            disabled
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-600 cursor-not-allowed rounded-lg mx-1 outline-none"
          >
            <Plus className="h-3.5 w-3.5" />
            Create workspace
            <span className="ml-auto text-[10px] text-zinc-600 bg-surface-inner px-1.5 py-0.5 rounded">Soon</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
