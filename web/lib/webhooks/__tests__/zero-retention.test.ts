/**
 * Tests for the zero-retention pipeline (Track E pieza 11).
 *
 * Acceptance gate: when X-IW-Zero-Retention is on, the pipeline runs
 * dedup + notify but writes ZERO rows to the alerts table. We assert
 * that here by stubbing the DB to track inserts and checking it's not
 * called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

vi.spyOn(console, "error").mockImplementation(() => undefined);
vi.spyOn(console, "warn").mockImplementation(() => undefined);

// ── DB stub: track inserts (must remain at 0 in zero-retention mode) ───────

const dbInserts: { table: string; values: unknown }[] = [];
const dbSelectChain = {
  from: () => dbSelectChain,
  where: () => dbSelectChain,
  limit: () => [],
};

vi.mock("@/lib/db", () => ({
  db: {
    select: () => dbSelectChain,
    insert: (table: { _name?: string }) => ({
      values: (v: unknown) => {
        dbInserts.push({ table: table?._name ?? "unknown", values: v });
        return {
          onConflictDoNothing: () => ({ returning: () => [] }),
          returning: () => [],
        };
      },
    }),
  },
  maintenanceWindows: {
    _name: "maintenanceWindows",
    id: "id",
    projectId: "projectId",
    startsAt: "startsAt",
    endsAt: "endsAt",
  },
  projects: { _name: "projects", id: "id", name: "name" },
  alerts: { _name: "alerts" },
}));

// ── Redis stub with NX semantics ────────────────────────────────────────────

const redisStore = new Map<string, unknown>();
const redisSetSpy = vi.fn(
  async (
    key: string,
    value: unknown,
    opts?: { ex?: number; nx?: boolean },
  ): Promise<"OK" | null> => {
    if (opts?.nx && redisStore.has(key)) return null;
    redisStore.set(key, value);
    return "OK";
  },
);

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({ set: redisSetSpy }),
}));

// ── Slack stub: track that postMessage fires ───────────────────────────────

const postMessageSpy = vi.fn(async () => ({ ok: true }));
const getSlackClientForProjectSpy = vi.fn(async () => ({
  client: { chat: { postMessage: postMessageSpy } },
  channelId: "C0000",
  installationId: "I0000",
}));

vi.mock("@/lib/slack/client", () => ({
  getSlackClientForProject: getSlackClientForProjectSpy,
}));

// ── Helper: tombstone keypair ──────────────────────────────────────────────

function freshSecretHex(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  return pkcs8.subarray(pkcs8.length - 32).toString("hex");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("processZeroRetention", () => {
  beforeEach(() => {
    dbInserts.length = 0;
    redisStore.clear();
    redisSetSpy.mockClear();
    postMessageSpy.mockClear();
    getSlackClientForProjectSpy.mockClear();
    vi.resetModules();
    process.env.INARIWATCH_TOMBSTONE_KEY_HEX = freshSecretHex();
  });

  afterEach(() => {
    delete process.env.INARIWATCH_TOMBSTONE_KEY_HEX;
  });

  it("never inserts into alerts", async () => {
    const { processZeroRetention } = await import(
      "@/lib/webhooks/zero-retention"
    );
    const result = await processZeroRetention({
      integrationId: "11111111-2222-3333-4444-555555555555",
      projectId: "proj-1",
      event: {
        title: "TypeError: Cannot read properties of undefined",
        body: "stack",
        severity: "critical",
        fingerprint: "fp-1",
      },
    });

    expect(result.status).toBe("tombstoned");
    expect(dbInserts).toHaveLength(0);
  });

  it("returns a verifiable signed tombstone with correct shape", async () => {
    const { processZeroRetention } = await import(
      "@/lib/webhooks/zero-retention"
    );
    const { verifyEd25519Signature } = await import(
      "@/lib/services/eap-verify-local"
    );

    const result = await processZeroRetention({
      integrationId: "11111111-2222-3333-4444-555555555555",
      projectId: "proj-1",
      event: {
        title: "DB timeout",
        body: "stack...",
        fingerprint: "fp-2",
      },
    });

    expect(result.status).toBe("tombstoned");
    if (result.status !== "tombstoned") return;

    const t = result.tombstone;
    expect(t.tombstone_id).toMatch(/^[0-9a-f]{64}$/);
    expect(t.sig).toMatch(/^ed25519:[0-9a-f]{128}$/);
    expect(t.processed_actions).toContain("analyzed");

    const verified = verifyEd25519Signature({
      receiptId: t.tombstone_id,
      signatureHex: t.sig.replace(/^ed25519:/, ""),
      publicKeyHex: t.pubkey,
    });
    expect(verified).toBe(true);
  });

  it("dedups via Redis and marks processed_actions=[deduplicated]", async () => {
    const { processZeroRetention } = await import(
      "@/lib/webhooks/zero-retention"
    );

    const event = {
      title: "Dup",
      body: "x",
      fingerprint: "same-fp",
    };

    const first = await processZeroRetention({
      integrationId: "11111111-2222-3333-4444-555555555555",
      projectId: "proj-1",
      event,
    });
    const second = await processZeroRetention({
      integrationId: "11111111-2222-3333-4444-555555555555",
      projectId: "proj-1",
      event,
    });

    expect(first.processedActions).toContain("analyzed");
    expect(second.processedActions).toEqual(["deduplicated"]);
    // Slack should only fire on the first hit.
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("sends Slack notification with zero-retention marker", async () => {
    const { processZeroRetention } = await import(
      "@/lib/webhooks/zero-retention"
    );

    await processZeroRetention({
      integrationId: "11111111-2222-3333-4444-555555555555",
      projectId: "proj-1",
      event: {
        title: "Boom",
        body: "trace",
        severity: "critical",
        fingerprint: "fp-slack",
      },
    });

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const call = postMessageSpy.mock.calls[0] as unknown as [
      { channel: string; text: string },
    ];
    expect(call[0].channel).toBe("C0000");
    expect(call[0].text).toContain("zero-retention");
    expect(call[0].text).toContain("Boom");
  });

  it("returns tombstoned-unsigned when key env is missing", async () => {
    delete process.env.INARIWATCH_TOMBSTONE_KEY_HEX;
    const { processZeroRetention } = await import(
      "@/lib/webhooks/zero-retention"
    );

    const result = await processZeroRetention({
      integrationId: "11111111-2222-3333-4444-555555555555",
      projectId: "proj-1",
      event: { title: "Boom", fingerprint: "fp-no-key" },
    });
    expect(result.status).toBe("tombstoned-unsigned");
    expect(dbInserts).toHaveLength(0);
  });
});

describe("hasZeroRetentionHeader", () => {
  it("matches lowercase value 1 only", async () => {
    const { hasZeroRetentionHeader } = await import(
      "@/lib/webhooks/zero-retention"
    );

    expect(
      hasZeroRetentionHeader(
        new Request("http://x", { headers: { "x-iw-zero-retention": "1" } }),
      ),
    ).toBe(true);
    expect(
      hasZeroRetentionHeader(
        new Request("http://x", { headers: { "X-IW-Zero-Retention": "1" } }),
      ),
    ).toBe(true);
    expect(
      hasZeroRetentionHeader(
        new Request("http://x", { headers: { "x-iw-zero-retention": "true" } }),
      ),
    ).toBe(false);
    expect(hasZeroRetentionHeader(new Request("http://x"))).toBe(false);
  });
});
