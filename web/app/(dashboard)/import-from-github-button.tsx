"use client";

import { signIn } from "next-auth/react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The unified "Import from GitHub" CTA used everywhere a project gets
 * created. Routes through NextAuth's GitHub provider (now wired to the
 * App's user-OAuth credentials), which:
 *
 *   - First-time users → combined consent screen (App install + OAuth).
 *   - Already-installed users → OAuth consent only, install carries
 *     forward; jwt callback's linkGitHubInstallationsForUser bulk-imports
 *     repos as projects.
 *
 * Why a client component instead of a plain <Link>: NextAuth's
 * /api/auth/signin/[provider] requires a CSRF-protected POST to start
 * the OAuth handshake. A GET on that URL renders the sign-in page
 * (which then POSTs internally) — bouncing the user through a useless
 * extra screen. signIn() from next-auth/react does the POST directly.
 */
export function ImportFromGitHubButton({
  variant = "primary",
  size = "sm",
  className = "",
  label = "Import from GitHub",
  fullWidth = false,
}: {
  variant?: "primary" | "outline";
  size?: "sm" | "md" | "lg";
  className?: string;
  label?: string;
  fullWidth?: boolean;
}) {
  return (
    <Button
      variant={variant}
      size={size}
      className={`gap-1.5 ${fullWidth ? "w-full" : ""} ${className}`}
      onClick={() => {
        void signIn("github", { callbackUrl: "/import" });
      }}
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </Button>
  );
}
