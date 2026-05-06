"use client";

import { signIn } from "next-auth/react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Unified "Import from GitHub" CTA used everywhere a project gets
 * created (dashboard header, /projects, /integrations).
 *
 * When `slug` is provided we redirect to
 * https://github.com/apps/<slug>/installations/new — GitHub treats App
 * OAuth and App install as independent flows, so `signIn("github")`
 * alone never creates an install row (it only mints a user-to-server
 * token). With "Request user authorization (OAuth) during installation"
 * enabled on the App, the install URL renders ONE combined consent
 * screen (install + OAuth), and the setup callback persists the row.
 *
 * Falls back to `signIn()` when `slug` is missing so a misconfigured
 * env still gives the user a clickable button — the OAuth handshake
 * works but no install row is created. Server-component callers
 * thread `slug` from `process.env.GITHUB_APP_SLUG`.
 */
export function ImportFromGitHubButton({
  slug,
  size = "sm",
  className = "",
  label = "Import from GitHub",
  fullWidth = false,
}: {
  slug?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  label?: string;
  fullWidth?: boolean;
}) {
  const sizeClasses =
    size === "sm" ? "h-8 px-3 text-sm"
      : size === "lg" ? "h-12 px-6 text-base"
      : "h-10 px-4 text-sm";

  if (slug) {
    return (
      <a
        href={`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`}
        className={`inline-flex items-center justify-center gap-1.5 rounded-lg bg-inari-accent font-semibold text-white transition-all hover:bg-[#f97316] active:bg-[#c2410c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 ${sizeClasses} ${fullWidth ? "w-full" : ""} ${className}`}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </a>
    );
  }

  return (
    <Button
      variant="primary"
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
