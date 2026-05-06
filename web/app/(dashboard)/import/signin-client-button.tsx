"use client";

import { signIn } from "next-auth/react";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * "Install GitHub App" CTA used on /import when the user has zero
 * githubAppInstallations rows. The user is already logged in
 * (otherwise the page redirected to /login), so they only need install
 * — not a fresh OAuth handshake.
 *
 * Why install URL and not signIn("github"): GitHub treats App OAuth
 * and App install as independent flows. `signIn("github")` hits
 * /login/oauth/authorize, which mints a user access token but does NOT
 * install the App. With the App's "Request user authorization (OAuth)
 * during installation" setting enabled, redirecting to
 * /apps/<slug>/installations/new shows ONE combined consent screen
 * (install + OAuth in a single click) and ends with a real install
 * row in our DB via the setup callback. This is the same pattern
 * Vercel/Linear/Sentry use.
 *
 * Falls back to signIn() when GITHUB_APP_SLUG isn't set so a
 * misconfigured env still lets the user attempt to connect — the
 * resulting OAuth-only flow won't create an install row, but it's
 * better than a dead button.
 */
export function SignInClientButton({ slug }: { slug?: string }) {
  if (slug) {
    return (
      <a
        href={`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-inari-accent px-6 text-base font-semibold text-white transition-all hover:bg-[#f97316] active:bg-[#c2410c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
      >
        <Github className="h-4 w-4" /> Install GitHub App
      </a>
    );
  }

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
