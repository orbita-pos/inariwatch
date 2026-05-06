/**
 * End-to-end tests for the NextAuth jwt callback in lib/auth.ts.
 *
 * These cover the three branches that determine identity:
 *
 *   1. Account-link mode — user is already logged in (token.id present)
 *      and clicks "Connect GitHub". Identity MUST be preserved.
 *      Regression target: silent account swap.
 *
 *   2. Returning user via provider mapping — user signed in with GitHub
 *      previously, logged out, signs back in. The (provider,
 *      providerAccountId) lookup must resolve to the original user even
 *      if their email no longer matches.
 *      Regression target: "logout → login with github creates a new user".
 *
 *   3. Fresh sign-in — first time we see this OAuth identity. Falls
 *      through to email-based upsert and persists the provider mapping
 *      so branch 2 catches them next time.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks (hoisted before module imports) ──────────────────────────────

const dbState = {
  // `accounts` table state, keyed by `${provider}::${providerAccountId}`
  accountByProviderId: new Map<string, { userId: string }>(),
  // `users` table state, keyed by id
  usersById:           new Map<string, { id: string; email: string; name: string | null; emailVerifiedAt: Date | null }>(),
  // `users` lookup index by email
  usersByEmail:        new Map<string, string>(),
  // captures: what was inserted/updated
  insertedUsers:       [] as Array<Record<string, unknown>>,
  updatedUsers:        [] as Array<Record<string, unknown>>,
};

vi.mock("@/lib/db", () => {
  const accountsTable = {
    userId:            Symbol("accounts.userId"),
    provider:          Symbol("accounts.provider"),
    providerAccountId: Symbol("accounts.providerAccountId"),
  };
  const usersTable = {
    id:    Symbol("users.id"),
    email: Symbol("users.email"),
  };

  // Each select() builder records which table it's against and which
  // `eq()` predicates the where clause carries (via and()/or() or as a
  // bare eq()). We piggyback on the Symbol identities by stringifying.
  function flattenConditions(clause: unknown): Array<{ column: symbol; value: string }> {
    if (!clause || typeof clause !== "object") return [];
    if ("column" in clause && "value" in clause) {
      return [clause as { column: symbol; value: string }];
    }
    if ("conditions" in clause) {
      const inner = (clause as { conditions: unknown[] }).conditions;
      return inner.flatMap(flattenConditions);
    }
    return [];
  }

  function makeSelect(table: typeof accountsTable | typeof usersTable) {
    return {
      from: () => ({
        where: (clause: unknown) => {
          const predicates: { provider?: string; providerAccountId?: string; email?: string; id?: string } = {};
          for (const c of flattenConditions(clause)) {
            const colKey = String(c.column);
            if (colKey.includes("provider)"))           predicates.provider = c.value;
            if (colKey.includes("providerAccountId)"))  predicates.providerAccountId = c.value;
            if (colKey.includes("email)"))              predicates.email = c.value;
            if (colKey.includes("id)"))                 predicates.id = c.value;
          }
          return {
            limit: async () => {
              if (table === accountsTable) {
                const k = `${predicates.provider}::${predicates.providerAccountId}`;
                const row = dbState.accountByProviderId.get(k);
                return row ? [{ userId: row.userId }] : [];
              }
              if (table === usersTable && predicates.email) {
                const id = dbState.usersByEmail.get(predicates.email);
                return id ? [dbState.usersById.get(id)] : [];
              }
              return [];
            },
          };
        },
      }),
    };
  }

  return {
    db: {
      select: () => ({
        from: (table: unknown) => makeSelect(table as typeof accountsTable | typeof usersTable).from(),
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            if (table === usersTable) {
              const id = `user-${dbState.usersById.size + 1}`;
              const row = {
                id,
                email:           values.email as string,
                name:            (values.name ?? null) as string | null,
                emailVerifiedAt: (values.emailVerifiedAt ?? null) as Date | null,
              };
              dbState.usersById.set(id, row);
              dbState.usersByEmail.set(row.email, id);
              dbState.insertedUsers.push({ ...values, id });
              return [row];
            }
            return [];
          },
          // accounts upsert path (no .returning)
          onConflictDoUpdate: async () => {
            // Persist into accountByProviderId so subsequent lookups find it.
            const k = `${values.provider}::${values.providerAccountId}`;
            dbState.accountByProviderId.set(k, { userId: values.userId as string });
          },
        }),
      }),
      update: () => ({
        set: (set: Record<string, unknown>) => ({
          where: async () => {
            dbState.updatedUsers.push(set);
          },
        }),
      }),
    },
    accounts: accountsTable,
    users:    usersTable,
  };
});

// drizzle-orm helpers — return shapes our mocked select can read.
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ type: "and", conditions: conditions.flatMap(extractConditions) }),
  or:  (...conditions: unknown[]) => ({ type: "or",  conditions: conditions.flatMap(extractConditions) }),
  eq:  (column: symbol, value: string) => ({ column, value }),
  isNull:  () => ({ type: "isNull" }),
  inArray: () => ({ type: "inArray" }),
  sql: () => ({ type: "sql" }),
  desc: (col: unknown) => col,
  asc:  (col: unknown) => col,
}));

function extractConditions(c: unknown): Array<{ column: symbol; value: string }> {
  if (!c) return [];
  if (typeof c === "object" && c !== null && "column" in c) {
    return [c as { column: symbol; value: string }];
  }
  if (typeof c === "object" && c !== null && "conditions" in c) {
    const inner = (c as { conditions: unknown[] }).conditions;
    return inner.flatMap(extractConditions);
  }
  return [];
}

// upsertProviderAccount + fetchPrimaryGitHubEmail — replace with stubs
// that record their calls and write into our shared dbState so the
// callback's flow is end-to-end observable.
const linkGitHubCalls: Array<{ userId: string; accessToken: string; organizationId: string | null }> = [];
let mockedPrimaryEmail: string | null = null;

vi.mock("@/lib/auth/oauth-helpers", () => ({
  upsertProviderAccount: async (args: { userId: string; provider: string; providerAccountId: string }) => {
    if (!args.providerAccountId) return;
    const k = `${args.provider}::${args.providerAccountId}`;
    dbState.accountByProviderId.set(k, { userId: args.userId });
  },
  fetchPrimaryGitHubEmail: async () => mockedPrimaryEmail,
}));

vi.mock("@/lib/auth/link-github-installation", () => ({
  linkGitHubInstallationsForUser: async (args: { userId: string; accessToken: string; organizationId: string | null }) => {
    linkGitHubCalls.push(args);
  },
}));

// Other auth.ts dependencies that we don't exercise here.
vi.mock("@/lib/auth-rate-limit", () => ({
  rateLimit: async () => ({ allowed: true }),
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (s: string) => s,
}));

// next-auth provider modules (avoid pulling them into the bundle).
vi.mock("next-auth/providers/credentials", () => ({ default: () => ({ id: "credentials", type: "credentials" }) }));
vi.mock("next-auth/providers/github",      () => ({ default: () => ({ id: "github",      type: "oauth"       }) }));
vi.mock("next-auth/providers/google",      () => ({ default: () => ({ id: "google",      type: "oauth"       }) }));
vi.mock("next-auth/providers/gitlab",      () => ({ default: () => ({ id: "gitlab",      type: "oauth"       }) }));

// otpauth + bcrypt — only used by the credentials provider, which
// these tests don't drive end-to-end.
vi.mock("otpauth", () => ({
  TOTP:   class { validate() { return null; } },
  Secret: { fromBase32: (s: string) => s },
}));
vi.mock("bcryptjs", () => ({ default: { compare: async () => false } }));

// ── Imports & test scaffolding ─────────────────────────────────────────

import { authOptions } from "../../auth";

type JwtCallback = NonNullable<NonNullable<typeof authOptions.callbacks>["jwt"]>;
const jwtCallback: JwtCallback = authOptions.callbacks!.jwt!;

beforeEach(() => {
  dbState.accountByProviderId.clear();
  dbState.usersById.clear();
  dbState.usersByEmail.clear();
  dbState.insertedUsers.length = 0;
  dbState.updatedUsers.length  = 0;
  linkGitHubCalls.length       = 0;
  mockedPrimaryEmail           = null;
  process.env.GITHUB_APP_CLIENT_ID = "test-client-id";
});

function seedUser(id: string, email: string) {
  dbState.usersById.set(id, { id, email, name: null, emailVerifiedAt: new Date() });
  dbState.usersByEmail.set(email, id);
}

function seedProviderMapping(provider: string, providerAccountId: string, userId: string) {
  dbState.accountByProviderId.set(`${provider}::${providerAccountId}`, { userId });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("jwt callback — branch 1: account-link mode (logged-in user)", () => {
  it("preserves token.id when GitHub returns a different email", async () => {
    // User A signed up with email a@example.com (credentials). They click
    // "Connect GitHub" while logged in; GitHub returns a profile whose
    // email is unrelated (b@example.com).
    seedUser("user-A", "a@example.com");
    const token = { id: "user-A", email: "a@example.com" };

    const result = await jwtCallback({
      token,
      account: {
        provider:          "github",
        type:              "oauth",
        providerAccountId: "gh-998",
        access_token:      "gho_xyz",
      },
      profile: { login: "alice", id: 998 },
      // The remaining fields aren't read by our callback; cast to any.
    } as Parameters<JwtCallback>[0]);

    expect(result.id).toBe("user-A");
    // Provider mapping was written so that next time logout→login
    // resolves back to A.
    expect(dbState.accountByProviderId.get("github::gh-998")).toEqual({ userId: "user-A" });
  });

  it("does not insert a new user", async () => {
    seedUser("user-A", "a@example.com");
    await jwtCallback({
      token: { id: "user-A", email: "a@example.com" },
      account: {
        provider:          "github",
        type:              "oauth",
        providerAccountId: "gh-1",
        access_token:      "tok",
      },
      profile: { login: "alice", id: 1 },
    } as Parameters<JwtCallback>[0]);

    expect(dbState.insertedUsers).toHaveLength(0);
  });

  it("preserves token.id for the credentials provider (no oauth side-effects)", async () => {
    // Credentials path: NextAuth's `authorize()` already returned the
    // user, so the row exists. The callback's email-lookup branch
    // re-resolves it. Crucially: no provider mapping is written
    // (providerAccountId is "") and no GitHub installations linker
    // is called, since neither belongs to a credentials sign-in.
    seedUser("user-A", "a@example.com");

    const result = await jwtCallback({
      token: { id: "user-A", email: "a@example.com" },
      account: {
        provider:          "credentials",
        type:              "credentials",
        providerAccountId: "",
      },
    } as Parameters<JwtCallback>[0]);

    expect(result.id).toBe("user-A");
    expect(dbState.accountByProviderId.size).toBe(0);
    expect(linkGitHubCalls).toHaveLength(0);
  });
});

describe("jwt callback — branch 2: returning user via provider mapping", () => {
  it("resolves to the original user even when GitHub email no longer matches", async () => {
    // User A signed up + linked GitHub previously. Now they log out and
    // come back via "Continue with GitHub". The GitHub OAuth profile
    // could carry any email (private, noreply, changed) — we resolve
    // by (provider, providerAccountId) regardless.
    seedUser("user-A", "a@example.com");
    seedProviderMapping("github", "gh-998", "user-A");

    const result = await jwtCallback({
      token: {}, // logged out — fresh JWT with no id yet
      account: {
        provider:          "github",
        type:              "oauth",
        providerAccountId: "gh-998",
        access_token:      "gho_new",
      },
      profile: { login: "alice", id: 998, email: "totally-different@example.com" },
    } as Parameters<JwtCallback>[0]);

    expect(result.id).toBe("user-A");
    expect(dbState.insertedUsers).toHaveLength(0);
    // installations linker called with the resolved user.
    expect(linkGitHubCalls).toEqual([{ userId: "user-A", accessToken: "gho_new", organizationId: null }]);
  });
});

describe("jwt callback — branch 3: fresh sign-in", () => {
  it("creates a user when no provider mapping and no email match exist", async () => {
    const result = await jwtCallback({
      token: { email: "newuser@example.com", name: "New User" },
      account: {
        provider:          "github",
        type:              "oauth",
        providerAccountId: "gh-555",
        access_token:      "gho_fresh",
      },
      profile: { login: "newuser", id: 555 },
    } as Parameters<JwtCallback>[0]);

    expect(result.id).toBe("user-1");
    expect(dbState.insertedUsers).toHaveLength(1);
    expect(dbState.insertedUsers[0]).toMatchObject({
      email: "newuser@example.com",
      name:  "New User",
    });
    // Provider mapping persisted so next sign-in hits branch 2.
    expect(dbState.accountByProviderId.get("github::gh-555")).toEqual({ userId: "user-1" });
  });

  it("falls back to GitHub noreply email when profile and /user/emails both omit it", async () => {
    mockedPrimaryEmail = null; // /user/emails returned nothing
    const result = await jwtCallback({
      token: {},
      account: {
        provider:          "github",
        type:              "oauth",
        providerAccountId: "gh-777",
        access_token:      "gho_priv",
      },
      profile: { login: "Quiet", id: 777 }, // no email here either
    } as Parameters<JwtCallback>[0]);

    expect(result.email).toBe("777+quiet@users.noreply.github.com");
    expect(result.id).toBe("user-1");
    expect(dbState.insertedUsers[0].email).toBe("777+quiet@users.noreply.github.com");
  });

  it("uses /user/emails when available (Vercel-style)", async () => {
    mockedPrimaryEmail = "real@example.com";
    const result = await jwtCallback({
      token: {},
      account: {
        provider:          "github",
        type:              "oauth",
        providerAccountId: "gh-888",
        access_token:      "gho_perm",
      },
      profile: { login: "real", id: 888 },
    } as Parameters<JwtCallback>[0]);

    expect(result.email).toBe("real@example.com");
    expect(dbState.insertedUsers[0].email).toBe("real@example.com");
  });

  it("adopts an existing user when email matches (e.g. signed up via Google, now using GitHub)", async () => {
    seedUser("user-A", "a@example.com");

    const result = await jwtCallback({
      token: { email: "a@example.com" },
      account: {
        provider:          "github",
        type:              "oauth",
        providerAccountId: "gh-111",
        access_token:      "gho_a",
      },
      profile: { login: "a", id: 111 },
    } as Parameters<JwtCallback>[0]);

    expect(result.id).toBe("user-A");
    expect(dbState.insertedUsers).toHaveLength(0);
    // Future sign-ins via GitHub now hit branch 2.
    expect(dbState.accountByProviderId.get("github::gh-111")).toEqual({ userId: "user-A" });
  });
});
