/**
 * Fase 3.5 hotfix — proves the worker container-agent stamps sandbox_mode
 * on the remediation session after pool checkout.
 *
 * Bug 2 said: "session 449a91f2 has sandbox_mode=NULL ... never persists
 * that to the DB column". The wiring already lives in container-agent.ts
 * (PR #13 / Fase 2b) but had no integration test, so a future refactor
 * could silently regress it. This test asserts:
 *   1. Pool hit  → writes "pool-warm"
 *   2. Pool miss → writes "pool-cold-fallback"
 *   3. Pool off  → no write attempt (preserves the null distinction the
 *                  /admin/remediation-lab dashboard uses)
 *   4. DB rejection is swallowed — telemetry never aborts remediation
 *
 * The DB is mocked via writeSandboxMode's injected client, so the test
 * runs without DATABASE_URL. The helper composes with sandboxModeFor()
 * exactly the way runAgentJob does.
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const ORIGINAL_FLAG = process.env.CONTAINER_POOL_ENABLED;
const ORIGINAL_DB_URL = process.env.DATABASE_URL;

// container-agent.ts → db.ts throws at module load when DATABASE_URL is
// missing. Set a stub *before* any dynamic import resolves the module
// graph. We're never going to actually talk to Postgres — the test
// injects a fake client.
if (!ORIGINAL_DB_URL) {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
}

function withFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.CONTAINER_POOL_ENABLED;
  else process.env.CONTAINER_POOL_ENABLED = value;
}

interface CapturedUpdate {
  values: { sandboxMode: string };
}

type WriteFn = (
  sessionId: string,
  mode: string | null,
  client: unknown,
) => Promise<void>;
type SandboxModeForFn = (source: "pool" | "cold" | null) => string | null;

function makeFakeDb(opts: { reject?: boolean } = {}): {
  client: unknown;
  updates: CapturedUpdate[];
} {
  const updates: CapturedUpdate[] = [];
  const client = {
    update: () => ({
      set: (values: { sandboxMode: string }) => {
        updates.push({ values });
        return {
          where: async () => {
            if (opts.reject) throw new Error("simulated Neon outage");
          },
        };
      },
    }),
  };
  return { client, updates };
}

describe("writeSandboxMode (Fase 3.5 hotfix Bug 2)", () => {
  let writeSandboxMode: WriteFn;
  let sandboxModeFor: SandboxModeForFn;

  before(async () => {
    const ca = await import("../container-agent.js");
    const pool = await import("../pool.js");
    writeSandboxMode = ca.writeSandboxMode as unknown as WriteFn;
    sandboxModeFor = pool.sandboxModeFor as unknown as SandboxModeForFn;
  });

  beforeEach(() => withFlag("true"));
  afterEach(() => withFlag(ORIGINAL_FLAG));

  it("writes 'pool-warm' when pool checkout succeeded", async () => {
    const { client, updates } = makeFakeDb();
    await writeSandboxMode("session-1", sandboxModeFor("pool"), client);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].values.sandboxMode, "pool-warm");
  });

  it("writes 'pool-cold-fallback' when pool checkout missed", async () => {
    const { client, updates } = makeFakeDb();
    await writeSandboxMode("session-2", sandboxModeFor("cold"), client);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].values.sandboxMode, "pool-cold-fallback");
  });

  it("skips the write entirely when the pool is disabled (mode = null)", async () => {
    withFlag("false");
    const { client, updates } = makeFakeDb();
    await writeSandboxMode("session-3", sandboxModeFor("cold"), client);
    assert.equal(updates.length, 0);
  });

  it("never throws when the DB rejects (telemetry must not abort remediation)", async () => {
    const { client, updates } = makeFakeDb({ reject: true });
    await assert.doesNotReject(
      writeSandboxMode("session-4", sandboxModeFor("pool"), client),
    );
    // The update was attempted before the failure.
    assert.equal(updates.length, 1);
    assert.equal(updates[0].values.sandboxMode, "pool-warm");
  });
});
