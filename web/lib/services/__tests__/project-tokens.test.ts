/**
 * project-tokens.service tests (Inari Live V1 — Session 2).
 *
 * Validates the pure helpers (token generation, hashing, fingerprint, DSN
 * emission, prefix detection) directly, and the DB-backed lifecycle
 * functions (mintToken, rotateToken, revokeToken, loadProjectByToken,
 * sweepRotateGrace) against a mocked Drizzle client.
 *
 * The mock keeps a single fake row in memory so we can assert that
 * mintToken returns plaintext exactly once + persists only the hash; that
 * rotateToken sets `rotated_to` and the cron sweep flips `revoked_at`
 * after the 24h grace; and that loadProjectByToken honours `revoked_at`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";

// ── In-memory DB substitute ────────────────────────────────────────────────

type Row = {
  id: string;
  projectId: string;
  workspaceId: string | null;
  tokenHash: string;
  tokenPrefix: string;
  scope: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  rotatedTo: string | null;
  createdVia: string;
  createdBy: string | null;
  deviceLabel: string | null;
};

const TABLES = {
  projectTokens: [] as Row[],
  projects: [] as { id: string; userId: string; organizationId: string | null }[],
  users: [] as { id: string; plan: string }[],
};

let nextId = 1;
function uuid() {
  // Stable shape, monotonic, sufficient for the test surface.
  const n = String(nextId++).padStart(12, "0");
  return `00000000-0000-0000-0000-${n}`;
}

// Drizzle's column references used by service queries — the mock matchers
// only need to identify which column we're filtering on, not its exact
// shape. We expose them as sentinel strings the predicate code below
// recognises.
const COL = {
  id:           "projectTokens.id",
  projectId:    "projectTokens.projectId",
  tokenHash:    "projectTokens.tokenHash",
  rotatedTo:    "projectTokens.rotatedTo",
  revokedAt:    "projectTokens.revokedAt",
  createdAt:    "projectTokens.createdAt",
  projectsId:        "projects.id",
  projectsOrgId:     "projects.organizationId",
  projectsUserId:    "projects.userId",
  usersId:           "users.id",
  usersPlan:         "users.plan",
};

vi.mock("drizzle-orm", () => {
  return {
    and: (...preds: unknown[]) => ({ __and: preds }),
    eq: (col: string, val: unknown) => ({ __eq: [col, val] }),
    desc: (col: string) => ({ __desc: col }),
    isNull: (col: string) => ({ __isNull: col }),
    lt: (col: string, val: unknown) => ({ __lt: [col, val] }),
    sql: (strings: TemplateStringsArray | unknown) => ({ __sql: String(strings) }),
  };
});

vi.mock("@/lib/db", () => ({
  // Schema tables — sentinel string columns the predicate matcher uses.
  projects: {
    id:             COL.projectsId,
    organizationId: COL.projectsOrgId,
    userId:         COL.projectsUserId,
  },
  users: {
    id:   COL.usersId,
    plan: COL.usersPlan,
  },
  projectTokens: {
    id:          COL.id,
    projectId:   COL.projectId,
    tokenHash:   COL.tokenHash,
    rotatedTo:   COL.rotatedTo,
    revokedAt:   COL.revokedAt,
    createdAt:   COL.createdAt,
  },
  db: {
    insert(_table: unknown) {
      return {
        values(data: Partial<Row>) {
          return {
            returning() {
              const row: Row = {
                id:           uuid(),
                projectId:    data.projectId!,
                workspaceId:  data.workspaceId ?? null,
                tokenHash:    data.tokenHash!,
                tokenPrefix:  data.tokenPrefix!,
                scope:        data.scope ?? ["events:write"],
                createdAt:    new Date(),
                lastUsedAt:   null,
                revokedAt:    null,
                rotatedTo:    null,
                createdVia:   data.createdVia!,
                createdBy:    data.createdBy ?? null,
                deviceLabel:  data.deviceLabel ?? null,
              };
              TABLES.projectTokens.push(row);
              return Promise.resolve([row]);
            },
          };
        },
      };
    },
    select(_proj?: unknown) {
      return {
        from(_table: unknown) {
          return {
            innerJoin(_t: unknown, _on: unknown) {
              return this;
            },
            where(pred: unknown) {
              const matchTokens = (rows: Row[]) =>
                rows.filter((r) => evalPredOnToken(pred, r));
              return {
                limit(_n: number) {
                  // Return shape depends on whether this is the project+user
                  // join (loadIntegrationByToken's plan lookup) or a token
                  // table query. Disambiguate by inspecting the predicate.
                  const pidEq = findPidEq(pred);
                  if (pidEq) {
                    const proj = TABLES.projects.find((p) => p.id === pidEq);
                    if (!proj) return Promise.resolve([]);
                    const user = TABLES.users.find((u) => u.id === proj.userId);
                    return Promise.resolve(user ? [{ plan: user.plan, organizationId: proj.organizationId }] : []);
                  }
                  return Promise.resolve(matchTokens(TABLES.projectTokens).slice(0, 1));
                },
                orderBy(_o: unknown) {
                  return Promise.resolve(matchTokens(TABLES.projectTokens));
                },
              };
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(patch: Partial<Row>) {
          return {
            where(pred: unknown) {
              const matched = TABLES.projectTokens.filter((r) => evalPredOnToken(pred, r));
              for (const r of matched) Object.assign(r, patch);
              const ret = matched.map((r) => ({ id: r.id }));
              const final = Promise.resolve(undefined) as Promise<unknown> & {
                returning?: () => Promise<{ id: string }[]>;
                catch?: <T>(fn: (e: unknown) => T) => Promise<T>;
              };
              final.returning = () => Promise.resolve(ret);
              final.catch = () => Promise.resolve(undefined as never);
              return final;
            },
          };
        },
      };
    },
  },
}));

// ── Predicate evaluator (used by the mock) ─────────────────────────────────

function evalPredOnToken(pred: unknown, row: Row): boolean {
  if (!pred || typeof pred !== "object") return true;
  const p = pred as Record<string, unknown>;
  if ("__and" in p) {
    const preds = (p as { __and: unknown[] }).__and;
    return preds.every((sp) => evalPredOnToken(sp, row));
  }
  if ("__eq" in p) {
    const [col, val] = (p as { __eq: [string, unknown] }).__eq;
    if (col === COL.id) return row.id === val;
    if (col === COL.projectId) return row.projectId === val;
    if (col === COL.tokenHash) return row.tokenHash === val;
  }
  if ("__isNull" in p) {
    const col = (p as { __isNull: string }).__isNull;
    if (col === COL.revokedAt) return row.revokedAt === null;
  }
  if ("__lt" in p) {
    const [col, val] = (p as { __lt: [string, unknown] }).__lt;
    if (col === COL.createdAt) return row.createdAt < (val as Date);
  }
  if ("__sql" in p) {
    // sql`${projectTokens.rotatedTo} IS NOT NULL` — hard-coded for the
    // sweep query; safe because that's the only sql`` we use.
    return row.rotatedTo !== null;
  }
  return true;
}

function findPidEq(pred: unknown): string | null {
  if (!pred || typeof pred !== "object") return null;
  const p = pred as Record<string, unknown>;
  if ("__eq" in p) {
    const [col, val] = (p as { __eq: [string, unknown] }).__eq;
    if (col === COL.projectsId) return String(val);
  }
  return null;
}

// ── Now we can import the service ──────────────────────────────────────────

const {
  generateTokenPlaintext,
  hashToken,
  tokenFingerprint,
  looksLikeProjectToken,
  TOKEN_PREFIX,
  ROTATE_GRACE_MS,
  tokenToDSN,
  mintToken,
  rotateToken,
  revokeToken,
  loadProjectByToken,
  sweepRotateGrace,
  ProjectTokenError,
} = await import("../project-tokens.service");

// ── Test helpers ────────────────────────────────────────────────────────────

const PROJECT_ID = uuid();
const WORKSPACE_ID = uuid();
const USER_ID = uuid();

beforeEach(() => {
  TABLES.projectTokens.length = 0;
  TABLES.projects.length = 0;
  TABLES.users.length = 0;
  nextId = 100;
  TABLES.projects.push({ id: PROJECT_ID, userId: USER_ID, organizationId: WORKSPACE_ID });
  TABLES.users.push({ id: USER_ID, plan: "pro" });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("token primitives", () => {
  it("generateTokenPlaintext starts with iwk_pub_v1_ and is reasonably long", () => {
    const t = generateTokenPlaintext();
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    // 32-byte base64url is 43 chars unpadded; +11 prefix = 54.
    expect(t.length).toBeGreaterThanOrEqual(50);
    expect(t.length).toBeLessThanOrEqual(80);
  });

  it("generateTokenPlaintext produces unique tokens", () => {
    const set = new Set();
    for (let i = 0; i < 50; i++) set.add(generateTokenPlaintext());
    expect(set.size).toBe(50);
  });

  it("hashToken returns a 64-char hex sha256 of the plaintext", () => {
    const t = "iwk_pub_v1_known";
    const h = hashToken(t);
    expect(h).toBe(createHash("sha256").update(t, "utf8").digest("hex"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tokenFingerprint takes the first 18 chars (prefix + 7 random)", () => {
    const fp = tokenFingerprint("iwk_pub_v1_aB3xY9k_extra_random");
    expect(fp).toBe("iwk_pub_v1_aB3xY9k");
    expect(fp.length).toBe(18);
  });

  it("looksLikeProjectToken accepts well-formed, rejects garbage", () => {
    expect(looksLikeProjectToken("iwk_pub_v1_" + "a".repeat(43))).toBe(true);
    expect(looksLikeProjectToken("iwk_pub_v1_short")).toBe(false);
    expect(looksLikeProjectToken("not-a-token")).toBe(false);
    expect(looksLikeProjectToken(null)).toBe(false);
    expect(looksLikeProjectToken(undefined)).toBe(false);
  });

  it("tokenToDSN assembles a Basic-Auth-style URL using APP_URL", () => {
    const prev = process.env.APP_URL;
    process.env.APP_URL = "https://example.test";
    try {
      const dsn = tokenToDSN("iwk_pub_v1_xxx", PROJECT_ID);
      expect(dsn).toBe(`https://iwk_pub_v1_xxx@example.test/capture/${PROJECT_ID}`);
    } finally {
      if (prev !== undefined) process.env.APP_URL = prev;
      else delete process.env.APP_URL;
    }
  });
});

// ── Mint ────────────────────────────────────────────────────────────────────

describe("mintToken", () => {
  it("returns the plaintext + fingerprint + DSN, persists only the hash", async () => {
    const result = await mintToken({
      projectId:   PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      createdVia:  "web",
      createdBy:   USER_ID,
      deviceLabel: "macbook-jesus",
    });

    expect(result.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(result.fingerprint).toBe(result.token.slice(0, 18));
    expect(result.dsn).toContain(result.token);
    expect(result.dsn).toContain(`/capture/${PROJECT_ID}`);

    expect(TABLES.projectTokens).toHaveLength(1);
    const row = TABLES.projectTokens[0];
    expect(row.tokenHash).toBe(hashToken(result.token));
    // Plaintext NEVER hits the row — only the hash + the 18-char prefix.
    expect(JSON.stringify(row)).not.toContain(result.token.slice(18));
    expect(row.tokenPrefix).toBe(result.fingerprint);
    expect(row.scope).toEqual(["events:write"]);
    expect(row.deviceLabel).toBe("macbook-jesus");
    expect(row.createdVia).toBe("web");
  });
});

// ── Rotate ──────────────────────────────────────────────────────────────────

describe("rotateToken", () => {
  it("mints a fresh token and links the old one via rotated_to", async () => {
    const old = await mintToken({
      projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    const fresh = await rotateToken({
      projectId: PROJECT_ID, oldTokenId: old.id, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });

    expect(fresh.id).not.toBe(old.id);
    expect(fresh.supersedes).toBe(old.id);
    expect(new Date(fresh.graceEndsAt).getTime()).toBeGreaterThan(Date.now());

    const oldRow = TABLES.projectTokens.find((r) => r.id === old.id)!;
    const newRow = TABLES.projectTokens.find((r) => r.id === fresh.id)!;
    expect(oldRow.rotatedTo).toBe(newRow.id);
    expect(oldRow.revokedAt).toBeNull();   // grace window
    expect(newRow.rotatedTo).toBeNull();
  });

  it("refuses to rotate an already-rotated token", async () => {
    const a = await mintToken({
      projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    await rotateToken({
      projectId: PROJECT_ID, oldTokenId: a.id, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    await expect(rotateToken({
      projectId: PROJECT_ID, oldTokenId: a.id, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    })).rejects.toBeInstanceOf(ProjectTokenError);
  });

  it("refuses to rotate a revoked token", async () => {
    const a = await mintToken({
      projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    await revokeToken({ projectId: PROJECT_ID, tokenId: a.id });
    await expect(rotateToken({
      projectId: PROJECT_ID, oldTokenId: a.id, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    })).rejects.toMatchObject({ code: "token_revoked" });
  });
});

// ── Revoke ──────────────────────────────────────────────────────────────────

describe("revokeToken", () => {
  it("marks the row revoked and is idempotent", async () => {
    const a = await mintToken({
      projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });

    const r1 = await revokeToken({ projectId: PROJECT_ID, tokenId: a.id });
    const r2 = await revokeToken({ projectId: PROJECT_ID, tokenId: a.id });

    expect(r1.revokedAt).toBeInstanceOf(Date);
    expect(r2.revokedAt.getTime()).toBe(r1.revokedAt.getTime());
    expect(TABLES.projectTokens[0].revokedAt).toEqual(r1.revokedAt);
  });

  it("404s when the token doesn't belong to the project", async () => {
    const a = await mintToken({
      projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    await expect(revokeToken({
      projectId: uuid(),  // different project
      tokenId:   a.id,
    })).rejects.toMatchObject({ code: "token_not_found" });
  });
});

// ── Lookup (capture webhook hot path) ───────────────────────────────────────

describe("loadProjectByToken", () => {
  it("returns the project + workspace for a live token", async () => {
    const minted = await mintToken({
      projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    const found = await loadProjectByToken(minted.token);
    expect(found).not.toBeNull();
    expect(found!.projectId).toBe(PROJECT_ID);
    expect(found!.workspaceId).toBe(WORKSPACE_ID);
    expect(found!.scope).toEqual(["events:write"]);
  });

  it("returns null for a revoked token", async () => {
    const minted = await mintToken({
      projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    await revokeToken({ projectId: PROJECT_ID, tokenId: minted.id });
    const found = await loadProjectByToken(minted.token);
    expect(found).toBeNull();
  });

  it("returns null for a malformed token (no DB hit)", async () => {
    expect(await loadProjectByToken("not-a-token")).toBeNull();
    expect(await loadProjectByToken("")).toBeNull();
  });

  it("accepts a rotated-but-not-yet-revoked token (grace window)", async () => {
    const old = await mintToken({
      projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    await rotateToken({
      projectId: PROJECT_ID, oldTokenId: old.id, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    // Old token still resolves until the cron sweep flips revokedAt.
    const stillLive = await loadProjectByToken(old.token);
    expect(stillLive).not.toBeNull();
    expect(stillLive!.projectId).toBe(PROJECT_ID);
    expect(stillLive!.rotatedTo).not.toBeNull();
  });
});

// ── Cron sweep ──────────────────────────────────────────────────────────────

describe("sweepRotateGrace", () => {
  it("revokes rotated tokens older than 24h", async () => {
    const old = await mintToken({
      projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    await rotateToken({
      projectId: PROJECT_ID, oldTokenId: old.id, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });

    // Backdate the old row so it appears past the grace window.
    const oldRow = TABLES.projectTokens.find((r) => r.id === old.id)!;
    oldRow.createdAt = new Date(Date.now() - ROTATE_GRACE_MS - 60_000);

    const result = await sweepRotateGrace();
    expect(result.revoked).toBe(1);
    expect(oldRow.revokedAt).toBeInstanceOf(Date);

    // The new (replacement) token must NOT have been swept — it has no rotated_to.
    const replacementId = oldRow.rotatedTo!;
    const fresh = TABLES.projectTokens.find((r) => r.id === replacementId)!;
    expect(fresh.revokedAt).toBeNull();
  });

  it("leaves rotated tokens still inside the grace window alone", async () => {
    const old = await mintToken({
      projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    await rotateToken({
      projectId: PROJECT_ID, oldTokenId: old.id, workspaceId: WORKSPACE_ID, createdVia: "web", createdBy: USER_ID,
    });
    // Default createdAt = now() — well within grace.
    const result = await sweepRotateGrace();
    expect(result.revoked).toBe(0);
  });
});
