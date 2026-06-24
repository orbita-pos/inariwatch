/**
 * Small, pure-ish helpers used by the NextAuth jwt callback in
 * lib/auth.ts. Lives in its own module so vitest can import them
 * without booting the full NextAuth surface (which pulls in JWT
 * libraries, providers, encryption, rate-limit clients, etc.).
 */

import { db, accounts } from "@/lib/db";

export interface ProviderAccountUpsert {
  userId:            string;
  provider:          string;
  providerAccountId: string;
  type:              string;
  accessToken:       string | null;
  refreshToken:      string | null;
  expiresAt:         number | null;
}

/**
 * Persist a (provider, providerAccountId) → userId mapping. Idempotent
 * via the `accounts_provider_account_unique` index added by migration
 * 0086. On conflict we refresh credentials and reassign the userId — a
 * legitimate case of provider id reassignment is rare but the upsert
 * makes the operation race-safe.
 *
 * Soft-fails on db errors so a transient issue doesn't block sign-in;
 * the next callback firing will get another chance to persist the row.
 */
export async function upsertProviderAccount(args: ProviderAccountUpsert): Promise<void> {
  if (!args.providerAccountId) return;
  try {
    await db
      .insert(accounts)
      .values({
        userId:            args.userId,
        provider:          args.provider,
        providerAccountId: args.providerAccountId,
        type:              args.type,
        accessToken:       args.accessToken,
        refreshToken:      args.refreshToken,
        expiresAt:         args.expiresAt,
      })
      .onConflictDoUpdate({
        target: [accounts.provider, accounts.providerAccountId],
        set: {
          userId:       args.userId,
          accessToken:  args.accessToken,
          refreshToken: args.refreshToken,
          expiresAt:    args.expiresAt,
          type:         args.type,
        },
      });
  } catch (err) {
    console.warn(
      "[auth] upsertProviderAccount failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

interface GitHubEmailRow {
  email:    string;
  primary:  boolean;
  verified: boolean;
}

/**
 * Fetch the user's primary verified email from GitHub's /user/emails
 * endpoint. Used only when the OAuth profile didn't carry an email
 * directly (GitHub Apps don't unless the App has the "Email addresses"
 * account permission). Returns null on any failure — caller falls
 * back to the noreply.github.com synthetic address.
 */
export async function fetchPrimaryGitHubEmail(accessToken: string): Promise<string | null> {
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
