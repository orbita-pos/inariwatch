import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import GitLabProvider from "next-auth/providers/gitlab";
import { decode as decodeJwt } from "next-auth/jwt";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import * as OTPAuth from "otpauth";
import { db, users, accounts } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { rateLimit } from "@/lib/auth-rate-limit";
import { decrypt } from "@/lib/crypto";
import {
  upsertProviderAccount,
  fetchPrimaryGitHubEmail,
} from "@/lib/auth/oauth-helpers";

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
    // Conflict gate — runs BEFORE jwt. Refuses an OAuth sign-in when a
    // user is already logged in AND the (provider, providerAccountId)
    // they're trying to connect is mapped to a DIFFERENT InariWatch user.
    //
    // Why this exists: NextAuth v4 with the jwt strategy does NOT pass
    // the existing session JWT into the jwt callback during an OAuth
    // round-trip — it builds a fresh token from the provider response.
    // That means the jwt callback's "account-link mode" (branch 1, see
    // below) never sees `token.id`, falls into branch 2 (provider lookup
    // in the accounts table), finds the GitHub identity already pointing
    // at user X, assigns `token.id = X` — and the currently-logged-in
    // user is silently swapped to X. Vercel/Linear/Stripe all reject
    // this case with an error rather than swap; we follow that pattern.
    //
    // We read the existing session cookie manually (NextAuth doesn't
    // expose the request here, but Next's cookies() does). If decode
    // fails, no cookie, or no token.id, we treat it as a fresh sign-in
    // and let it through — only the "logged-in user already + identity
    // belongs to someone else" combination is rejected.
    async signIn({ account }) {
      if (!account || account.type !== "oauth") return true;
      const providerAccountId = String(account.providerAccountId ?? "");
      if (!providerAccountId) return true;

      const cookieStore = await cookies();
      const sessionToken =
        cookieStore.get("__Secure-next-auth.session-token")?.value
        ?? cookieStore.get("next-auth.session-token")?.value;
      if (!sessionToken) return true;

      const secret = process.env.NEXTAUTH_SECRET;
      if (!secret) return true;

      let currentUserId: string | undefined;
      try {
        const decoded = await decodeJwt({ token: sessionToken, secret });
        currentUserId = (decoded as { id?: string } | null)?.id;
      } catch {
        // Token expired / signature mismatch / decoder error — treat as
        // no session, let normal flow proceed.
        return true;
      }
      if (!currentUserId) return true;

      const [existing] = await db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(
          and(
            eq(accounts.provider, account.provider),
            eq(accounts.providerAccountId, providerAccountId),
          ),
        )
        .limit(1);

      if (existing && existing.userId !== currentUserId) {
        // Conflict — refuse. Redirect string short-circuits NextAuth
        // before the jwt callback runs, so the existing session cookie
        // is preserved untouched.
        //
        // Land on /import (the "connect GitHub" surface) so the still-
        // logged-in user sees the error in context. Don't use /login —
        // middleware bounces logged-in users from /login → /dashboard,
        // and /dashboard redirects fresh users to /import anyway,
        // dropping the ?error= along the way.
        return "/import?error=OAuthAccountConflict";
      }

      return true;
    },

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
        // Instead: keep the current `token.id`, persist the provider
        // mapping under (provider, providerAccountId) so future sign-ins
        // resolve back to this same user, link GitHub installations, and
        // skip the email-based upsert below.
        if (token.id && account.provider !== "credentials") {
          await upsertProviderAccount({
            userId:            token.id as string,
            provider:          account.provider,
            providerAccountId: String(account.providerAccountId ?? ""),
            type:              account.type,
            accessToken:       typeof account.access_token === "string" ? account.access_token : null,
            refreshToken:      typeof account.refresh_token === "string" ? account.refresh_token : null,
            expiresAt:         typeof account.expires_at === "number" ? account.expires_at : null,
          });

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
          }
          return token;
        }

        // ── Fresh sign-in path ───────────────────────────────────────────
        // Step 1: stable provider lookup. If this OAuth identity has
        // signed in before we already know which user row it belongs to,
        // even if their email has since changed (or never matched in the
        // first place — e.g. private GitHub email + noreply fallback).
        const providerAccountId = String(account.providerAccountId ?? "");
        if (providerAccountId && account.provider !== "credentials") {
          const [linked] = await db
            .select({ userId: accounts.userId })
            .from(accounts)
            .where(
              and(
                eq(accounts.provider, account.provider),
                eq(accounts.providerAccountId, providerAccountId),
              ),
            )
            .limit(1);
          if (linked) {
            token.id = linked.userId;
            // Refresh tokens on the account row so downstream callers
            // (installations linker below, future API uses) see the
            // latest credentials, not whatever was stashed last time.
            await upsertProviderAccount({
              userId:            linked.userId,
              provider:          account.provider,
              providerAccountId,
              type:              account.type,
              accessToken:       typeof account.access_token === "string" ? account.access_token : null,
              refreshToken:      typeof account.refresh_token === "string" ? account.refresh_token : null,
              expiresAt:         typeof account.expires_at === "number" ? account.expires_at : null,
            });

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
                  userId:         linked.userId,
                  accessToken:    account.access_token,
                  organizationId: null,
                });
              } catch (err) {
                console.warn(
                  "[auth] linkGitHubInstallationsForUser (returning user) failed:",
                  err instanceof Error ? err.message : err,
                );
              }
            }
            return token;
          }
        }

        // Step 2: no provider mapping yet — resolve the email so we can
        // either find an existing user row by email or create a new one.
        // GitHub App user-OAuth doesn't surface email by default, so we
        // try /user/emails (Vercel-style) and fall back to the GitHub
        // noreply address.
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

        // Step 3: persist the provider mapping so the next sign-in
        // resolves directly via Step 1 instead of going through email
        // lookup. Skipped for the credentials provider (no provider id).
        if (providerAccountId) {
          await upsertProviderAccount({
            userId:            dbUser.id,
            provider:          account.provider,
            providerAccountId,
            type:              account.type,
            accessToken:       typeof account.access_token === "string" ? account.access_token : null,
            refreshToken:      typeof account.refresh_token === "string" ? account.refresh_token : null,
            expiresAt:         typeof account.expires_at === "number" ? account.expires_at : null,
          });
        }

        // GitHub App OAuth — when the user just signed in via the App's
        // user-OAuth (GITHUB_APP_CLIENT_ID), the access_token in `account`
        // can list our App's installations they have access to. Soft-fail:
        // if the token is from the legacy OAuth App or the call rejects,
        // the user lands on /import which has its own "no installations"
        // CTA.
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
              organizationId: null,
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

