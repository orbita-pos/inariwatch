import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import GitLabProvider from "next-auth/providers/gitlab";
import bcrypt from "bcryptjs";
import * as OTPAuth from "otpauth";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import { rateLimit } from "@/lib/auth-rate-limit";
import { decrypt } from "@/lib/crypto";

// Precomputed bcryptjs hash at cost 12 of a constant string that nobody
// will ever submit as a password. Used to force `bcrypt.compare` to run
// even when the user-lookup branch returns no row — otherwise the "user
// not found" path returns ~250 ms faster than the "user found, wrong
// password" path, which is a usable email-enumeration oracle. Cost 12
// matches register/reset actions so the timing is indistinguishable.
const DUMMY_PASSWORD_HASH =
  "$2a$12$sbSozBz44ZIwfKfmqXcUO.ZjLQE0qfHPooEgjKyckxz8237tAyWxO";

export const authOptions: NextAuthOptions = {
  session: { 
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },

  providers: [
    // Vercel-style GitHub auth — when GITHUB_APP_CLIENT_ID is set, this
    // provider uses the GitHub App's user-OAuth credentials (different
    // from a stand-alone OAuth App). With "Request user authorization
    // (OAuth) during installation" enabled on the App, signing in via
    // GitHub also installs / re-uses the App in one screen, so the
    // user's `/user/installations` already lists their accessible repos
    // when they land on /import — zero extra "now install the App" step.
    //
    // Falls back to the legacy OAuth App credentials when the new ones
    // aren't populated yet, so the swap is safe to merge before the
    // sops update lands. After GITHUB_APP_CLIENT_ID is in sops, the
    // App-OAuth flow takes over automatically (no rebuild — just env
    // push). Either way the route is the same NextAuth GitHubProvider.
    GitHubProvider({
      clientId:     process.env.GITHUB_APP_CLIENT_ID    ?? process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? process.env.GITHUB_CLIENT_SECRET!,
    }),

    // Google OAuth (optional — only enabled if env vars are set)
    ...(process.env.GOOGLE_CLIENT_ID
      ? [
        GoogleProvider({
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        }),
      ]
      : []),

    // GitLab OAuth (optional — only enabled if env vars are set)
    ...(process.env.GITLAB_CLIENT_ID
      ? [
        GitLabProvider({
          clientId: process.env.GITLAB_CLIENT_ID,
          clientSecret: process.env.GITLAB_CLIENT_SECRET!,
        }),
      ]
      : []),

    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        totp: { label: "2FA Code", type: "text" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        // Rate limit: 10 login attempts per email per 15 minutes
        const rl = await rateLimit("login", credentials.email.toLowerCase(), {
          windowMs: 15 * 60_000,
          max: 10,
        });
        if (!rl.allowed) {
          throw new Error("TOO_MANY_ATTEMPTS");
        }

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, credentials.email))
          .limit(1);

        // Constant-time: always run bcrypt.compare, even when the user
        // doesn't exist or has no password hash (e.g. OAuth-only user).
        // This removes the timing oracle on email enumeration — "user
        // not found" now takes the same ~250 ms as "user found, wrong
        // password". The post-compare null check preserves the original
        // reject semantics.
        const valid = await bcrypt.compare(
          credentials.password,
          user?.passwordHash ?? DUMMY_PASSWORD_HASH,
        );
        if (!user || !user.passwordHash || !valid) return null;

        // Check 2FA if enabled
        if (user.twoFactorEnabled && user.totpSecret) {
          const totpCode = credentials.totp;
          if (!totpCode) {
            throw new Error("2FA_REQUIRED");
          }

          const decryptedSecret = decrypt(user.totpSecret);
          const totp = new OTPAuth.TOTP({
            issuer: "InariWatch",
            label: user.email,
            algorithm: "SHA1",
            digits: 6,
            period: 30,
            secret: OTPAuth.Secret.fromBase32(decryptedSecret),
          });

          const delta = totp.validate({ token: totpCode, window: 1 });
          if (delta === null) {
            throw new Error("INVALID_2FA");
          }
        }

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],

  callbacks: {
    // Called on every sign-in (OAuth or credentials).
    // For OAuth: upsert the user in our DB so we have a real UUID.
    async jwt({ token, account, profile }) {
      if (account) {
        // ── Account-link mode ────────────────────────────────────────────
        // NextAuth passes the EXISTING decoded JWT as `token` when an
        // already-logged-in user re-runs `signIn()` (e.g. clicking
        // "Connect GitHub" on the dashboard). In that case `token.id` is
        // already populated — we must NOT swap identity to whichever
        // user matches the GitHub email, because that would silently
        // hijack the session into a different account.
        //
        // Instead: keep the current `token.id`, persist the GitHub
        // installation rows under that user, and skip the email-based
        // upsert below. The user's primary email stays whatever they
        // signed up with; GitHub is now linked to that account.
        if (
          token.id &&
          account.provider === "github" &&
          typeof account.access_token === "string" &&
          process.env.GITHUB_APP_CLIENT_ID
        ) {
          try {
            const { linkGitHubInstallationsForUser } = await import(
              "@/lib/auth/link-github-installation"
            );
            await linkGitHubInstallationsForUser({
              userId:         token.id as string,
              accessToken:    account.access_token,
              organizationId: null,
            });
          } catch (err) {
            console.warn(
              "[auth] linkGitHubInstallationsForUser (linking) failed:",
              err instanceof Error ? err.message : err,
            );
          }
          return token;
        }
        if (token.id) {
          // Other providers (Google/GitLab) re-OAuth on a logged-in
          // session: same rule — preserve identity, no-op.
          return token;
        }

        // ── Fresh sign-in path ───────────────────────────────────────────
        // GitHub App user-OAuth tokens don't carry `email` in the profile
        // by default (Apps use per-permission grants, not OAuth scopes).
        // Try `/user/emails` with the access_token first — Vercel-style;
        // returns the verified primary when the App has "Email addresses"
        // permission. Fall back to the GitHub noreply address so the row
        // is still anchored to a real GitHub identity. Never blocks sign-in.
        let email = token.email;
        if (!email && account.provider === "github" && typeof account.access_token === "string") {
          const fetched = await fetchPrimaryGitHubEmail(account.access_token);
          if (fetched) {
            email = fetched;
            token.email = fetched;
          }
        }
        if (!email && account.provider === "github") {
          const ghProfile = profile as { login?: string; id?: number } | undefined;
          if (ghProfile?.login && ghProfile.id) {
            email = `${ghProfile.id}+${ghProfile.login.toLowerCase()}@users.noreply.github.com`;
            token.email = email;
          }
        }
        if (!email) return token;

        // OAuth providers (GitHub/Google/GitLab) verify emails before returning
        // them, so the verification claim is authoritative. Credentials provider
        // doesn't reach this branch (`account` is only set on OAuth sign-ins).
        // NextAuth v4 labels Google (OIDC) as `oauth`, so one check covers all.
        const isOAuth = account.type === "oauth";

        const result = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        let dbUser = result[0];

        if (!dbUser) {
          const insertedResult = await db
            .insert(users)
            .values({
              email,
              name: token.name ?? null,
              emailVerifiedAt: isOAuth ? new Date() : null,
            })
            .returning();

          dbUser = (insertedResult as typeof users.$inferSelect[])[0];
        } else if (isOAuth && !dbUser.emailVerifiedAt) {
          // Backfill existing OAuth users whose emailVerifiedAt was never set
          // (pre-fix accounts). Next login flips them to verified.
          await db
            .update(users)
            .set({ emailVerifiedAt: new Date() })
            .where(eq(users.id, dbUser.id));
        }

        token.id = dbUser.id;

        // GitHub App OAuth — when the user just signed in via the App's
        // user-OAuth (GITHUB_APP_CLIENT_ID), the access_token in `account`
        // can list our App's installations they have access to. Auto-link
        // them so the user lands on /dashboard with repos already imported,
        // skipping the separate "now install the App" step. Soft-fail: if
        // the token is from the legacy OAuth App or the call rejects, the
        // import is a no-op and the existing /onboarding flow takes over.
        if (
          account.provider === "github" &&
          typeof account.access_token === "string" &&
          process.env.GITHUB_APP_CLIENT_ID
        ) {
          try {
            const { linkGitHubInstallationsForUser } = await import(
              "@/lib/auth/link-github-installation"
            );
            await linkGitHubInstallationsForUser({
              userId:         dbUser.id,
              accessToken:    account.access_token,
              organizationId: null, // Workspace selection happens later from /settings.
            });
          } catch (err) {
            console.warn(
              "[auth] linkGitHubInstallationsForUser failed:",
              err instanceof Error ? err.message : err,
            );
          }
        }
      }

      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string }).id = token.id as string;
      }
      return session;
    },

    async redirect({ url, baseUrl }) {
      // Respect callbackUrl if it's on the same origin
      if (url.startsWith(baseUrl)) return url;
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      // Default: go to dashboard
      return `${baseUrl}/dashboard`;
    },
  },

  pages: {
    signIn: "/login",
    signOut: "/signout",
  },
};

interface GitHubEmailRow {
  email:    string;
  primary:  boolean;
  verified: boolean;
}

async function fetchPrimaryGitHubEmail(accessToken: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const rows = (await res.json().catch(() => null)) as GitHubEmailRow[] | null;
  if (!Array.isArray(rows)) return null;
  const primary = rows.find((r) => r.primary && r.verified);
  if (primary) return primary.email.toLowerCase();
  const anyVerified = rows.find((r) => r.verified);
  return anyVerified ? anyVerified.email.toLowerCase() : null;
}
