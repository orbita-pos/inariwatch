"use client";

import { signIn } from "next-auth/react";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * "Install GitHub App" CTA used on /import when the user has zero
 * githubAppInstallations rows. The user is already logged in (otherwise
 * the page redirected to /login), so we route through `signIn("github")`
 * to keep the existing session cookie intact across the OAuth round trip
 * — see import-from-github-button.tsx for the full rationale (account-
 * swap risk when bypassing NextAuth via the install URL directly).
 *
 * The App has "Request user authorization (OAuth) during installation"
 * enabled, so the single consent screen does both OAuth and install in
 * one click.
 */
export function SignInClientButton() {
  return (
    <Button
      variant="primary"
      size="lg"
      className="w-full gap-2"
      onClick={() => {
        void signIn("github", { callbackUrl: "/import" });
      }}
    >
      <Github className="h-4 w-4" /> Continue with GitHub
    </Button>
  );
}
