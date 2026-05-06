"use client";

import { signIn } from "next-auth/react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Unified "Import from GitHub" CTA used everywhere a project gets created
 * (dashboard header, /projects, /integrations).
 *
 * Always routes through `signIn("github")` instead of jumping straight to
 * the App's install URL — the install URL bypasses NextAuth, so the OAuth
 * state cookie is never minted, and a callback that lands while the user
 * is signed-in to a different GitHub account ends up in the jwt callback's
 * fresh-sign-in branch (email lookup → silent account swap). With
 * `signIn()` the existing session cookie travels through the OAuth round
 * trip, the jwt callback's "account-link" branch fires, identity is
 * preserved, and the App install completes inside the same OAuth handshake
 * (the App has "Request user authorization (OAuth) during installation"
 * enabled, so a single consent screen does both).
 */
export function ImportFromGitHubButton({
  size = "sm",
  className = "",
  label = "Import from GitHub",
  fullWidth = false,
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
  label?: string;
  fullWidth?: boolean;
}) {
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
