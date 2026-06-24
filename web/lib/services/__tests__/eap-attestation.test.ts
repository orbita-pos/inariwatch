/**
 * Tests for submitReceiptForRemediation — VAR Q3 Phase 2.
 *
 * Locks down the contract the caller (remediate.ts post-merge path)
 * relies on: never throws, never blocks, returns a discriminated
 * SubmitOutcome for every code path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.spyOn(console, "error").mockImplementation(() => undefined);

// Drizzle mock — same chainable pattern used by other service tests.
// selectQueue supplies each SELECT's result, updateSeen records any
// UPDATE call so we can assert the eap_receipt_id write.

let selectQueue: unknown[][] = [];
const updateSeen: Array<{ set: Record<string, unknown> }> = [];
const insertSeen: Array<{ table: string; values: Record<string, unknown> }> = [];

function selectChain() {
  const obj: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "leftJoin", "where", "limit", "orderBy"]) obj[m] = () => obj;
  obj.then = (resolve: (v: unknown) => void) => resolve(selectQueue.shift() ?? []);
  return obj;
}

function updateChain() {
  const obj: Record<string, unknown> = {};
  obj.set = (v: Record<string, unknown>) => {
    updateSeen.push({ set: v });
    return obj;
  };
  obj.where = () => obj;
  // drizzle-orm awaits the final .where() — it's thenable.
  obj.then = (resolve: (v: unknown) => void) => resolve(undefined);
  return obj;
}

function insertChain(tableName: string) {
  const obj: Record<string, unknown> = {};
  obj.values = (v: Record<string, unknown>) => {
    insertSeen.push({ table: tableName, values: v });
    return obj;
  };
  obj.onConflictDoNothing = () => obj;
  // drizzle-orm awaits the final chained call — make every node thenable.
  obj.then = (resolve: (v: unknown) => void) => resolve(undefined);
  return obj;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => selectChain(),
    update: () => updateChain(),
    insert: (tbl: { _name?: string }) => insertChain(tbl?._name ?? "unknown"),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  alerts: { id: "id", sessionId: "session_id", _name: "alerts" },
  remediationSessions: {
    id: "id",
    alertId: "alert_id",
    repo: "repo",
    branch: "branch",
    mergedCommitSha: "merged_commit_sha",
    eapReceiptId: "eap_receipt_id",
    updatedAt: "updated_at",
    _name: "remediation_sessions",
  },
  substrateRecordings: {
    recordingId: "recording_id",
    command: "command",
    runtime: "runtime",
    startedAt: "started_at",
    endedAt: "ended_at",
    events: "events",
    sessionId: "session_id",
    alertId: "alert_id",
    createdAt: "created_at",
    _name: "substrate_recordings",
  },
  eapReceipts: {
    receiptId: "receipt_id",
    alertId: "alert_id",
    remediationSessionId: "remediation_session_id",
    recordingId: "recording_id",
    merkleRoot: "merkle_root",
    signature: "signature",
    signed: "signed",
    eventCount: "event_count",
    attestor: "attestor",
    _name: "eap_receipts",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (a: unknown, b: unknown) => ({ _eq: [a, b] }),
  desc: (a: unknown) => ({ _desc: a }),
  isNotNull: (a: unknown) => ({ _isNotNull: a }),
}));

const RECEIPT_ID = "d".repeat(64);
const REMEDIATION_ID = "00000000-0000-4000-8000-000000000001";
const ALERT_ID = "00000000-0000-4000-8000-0000000000aa";

async function load() {
  return await import("../eap-attestation.service");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  selectQueue = [];
  updateSeen.length = 0;
  insertSeen.length = 0;
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

// ── Skip paths ───────────────────────────────────────────────────────────

describe("submitReceiptForRemediation — skip paths", () => {
  it("returns 'eap-not-configured' when EAP_SERVER_URL unset", async () => {
    vi.stubEnv("EAP_SERVER_URL", "");
    const { submitReceiptForRemediation } = await load();
    const r = await submitReceiptForRemediation(REMEDIATION_ID);
    expect(r).toEqual({ ok: false, skipped: "eap-not-configured" });
  });

  it("returns 'remediation not found' when row missing", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example");
    selectQueue.push([]); // remediation lookup comes back empty
    const { submitReceiptForRemediation } = await load();
    const r = await submitReceiptForRemediation(REMEDIATION_ID);
    expect(r).toEqual({ ok: false, failed: "remediation not found" });
  });

  it("returns 'already-attested' when eapReceiptId already set", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example");
    selectQueue.push([
      {
        id: REMEDIATION_ID,
        alertId: ALERT_ID,
        command: "owner/repo",
        branch: "radar/fix",
        mergedCommitSha: "abc",
        existingReceiptId: RECEIPT_ID,
        alertSessionId: null,
      },
    ]);
    const { submitReceiptForRemediation } = await load();
    const r = await submitReceiptForRemediation(REMEDIATION_ID);
    expect(r).toEqual({ ok: false, skipped: "already-attested" });
  });

  it("returns 'no-recording-found' when no substrate recording exists", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example");
    selectQueue.push([
      {
        id: REMEDIATION_ID,
        alertId: ALERT_ID,
        command: "owner/repo",
        branch: null,
        mergedCommitSha: null,
        existingReceiptId: null,
        alertSessionId: "sess_abc",
      },
    ]);
    selectQueue.push([]); // substrate recording lookup
    const { submitReceiptForRemediation } = await load();
    const r = await submitReceiptForRemediation(REMEDIATION_ID);
    expect(r).toEqual({ ok: false, skipped: "no-recording-found" });
  });

  it("returns 'no-recording-found' when events array is empty", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example");
    selectQueue.push([
      {
        id: REMEDIATION_ID,
        alertId: ALERT_ID,
        command: "owner/repo",
        branch: null,
        mergedCommitSha: null,
        existingReceiptId: null,
        alertSessionId: "sess_abc",
      },
    ]);
    selectQueue.push([
      {
        recordingId: "rec_1",
        command: "node fix.js",
        runtime: "node",
        startedAt: new Date("2026-04-17T00:00:00Z"),
        endedAt: new Date("2026-04-17T00:00:05Z"),
        events: [],
      },
    ]);
    const { submitReceiptForRemediation } = await load();
    const r = await submitReceiptForRemediation(REMEDIATION_ID);
    expect(r).toEqual({ ok: false, skipped: "no-recording-found" });
  });
});

// ── Happy path ───────────────────────────────────────────────────────────

describe("submitReceiptForRemediation — submission", () => {
  function seedSuccessfulLookup() {
    selectQueue.push([
      {
        id: REMEDIATION_ID,
        alertId: ALERT_ID,
        command: "owner/repo",
        branch: "radar/fix",
        mergedCommitSha: "abc",
        existingReceiptId: null,
        alertSessionId: "sess_abc",
      },
    ]);
    selectQueue.push([
      {
        recordingId: "rec_test",
        command: "node fix.js",
        runtime: "node",
        startedAt: new Date("2026-04-17T00:00:00Z"),
        endedAt: new Date("2026-04-17T00:00:05Z"),
        events: [
          { seq: 0, timestamp_ns: 0, kind: { type: "http_request", id: 0, method: "POST", url: "/a" } },
        ],
      },
    ]);
  }

  it("POSTs to EAP, persists receipt_id, returns ok+receiptId", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example.com");
    vi.stubEnv("EAP_API_KEY", "secret-xyz");
    seedSuccessfulLookup();

    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "created",
          receipt_id: RECEIPT_ID,
          event_count: 1,
          signed: true,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { submitReceiptForRemediation } = await load();
    const r = await submitReceiptForRemediation(REMEDIATION_ID);

    expect(r).toEqual({
      ok: true,
      receiptId: RECEIPT_ID,
      status: "created",
      signed: true,
    });

    // Called the right URL with the bearer.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("https://eap.example.com/receipts/from-events");
    const headers = call[1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-xyz");
    expect(headers["content-type"]).toBe("application/json");

    // Body carries the right shape.
    const body = JSON.parse(call[1].body as string);
    expect(body.recording_id).toBe("rec_test");
    expect(body.command).toEqual(["node", "fix.js"]);
    expect(body.runtime).toBe("node");
    expect(body.events).toHaveLength(1);
    expect(body.attestor).toBe("inariwatch");

    // Persisted the receipt_id on the remediation.
    expect(updateSeen).toHaveLength(1);
    expect(updateSeen[0]!.set.eapReceiptId).toBe(RECEIPT_ID);

    // Fase 11 — also mirrored into eap_receipts for fast local lookup.
    const mirror = insertSeen.find((i) => i.table === "eap_receipts");
    expect(mirror, "expected an insert into eap_receipts").toBeDefined();
    expect(mirror!.values.receiptId).toBe(RECEIPT_ID);
    expect(mirror!.values.merkleRoot).toBe(RECEIPT_ID);
    expect(mirror!.values.alertId).toBe(ALERT_ID);
    expect(mirror!.values.remediationSessionId).toBe(REMEDIATION_ID);
    expect(mirror!.values.recordingId).toBe("rec_test");
    expect(mirror!.values.signed).toBe(true);
    expect(mirror!.values.eventCount).toBe(1);
    expect(mirror!.values.attestor).toBe("inariwatch");
    // Signature is intentionally NULL — EAP /receipts/from-events response
    // does not include the raw signature; the verify endpoint fetches
    // /chain/:id lazily when needed.
    expect(mirror!.values.signature).toBeNull();
  });

  it("omits bearer header when EAP_API_KEY is unset", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example.com");
    vi.stubEnv("EAP_API_KEY", "");
    seedSuccessfulLookup();

    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "created",
          receipt_id: RECEIPT_ID,
          event_count: 1,
          signed: true,
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { submitReceiptForRemediation } = await load();
    const r = await submitReceiptForRemediation(REMEDIATION_ID);
    expect(r.ok).toBe(true);
    const call = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("returns failed on network error without throwing", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example.com");
    seedSuccessfulLookup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED internal.10.0.0.1:9402");
      }),
    );
    const { submitReceiptForRemediation } = await load();
    const r = await submitReceiptForRemediation(REMEDIATION_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect("failed" in r ? r.failed : "").toMatch(/network/);
  });

  it("returns failed on upstream 5xx without persisting", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example.com");
    seedSuccessfulLookup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const { submitReceiptForRemediation } = await load();
    const r = await submitReceiptForRemediation(REMEDIATION_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect("failed" in r ? r.failed : "").toBe("upstream 500");
    // Crucially — no UPDATE was performed.
    expect(updateSeen).toHaveLength(0);
  });

  it("returns failed when upstream returns malformed receipt_id", async () => {
    vi.stubEnv("EAP_SERVER_URL", "https://eap.example.com");
    seedSuccessfulLookup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: "created",
            receipt_id: "not-a-real-hash",
            event_count: 1,
            signed: true,
          }),
          { status: 201 },
        ),
      ),
    );
    const { submitReceiptForRemediation } = await load();
    const r = await submitReceiptForRemediation(REMEDIATION_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect("failed" in r ? r.failed : "").toMatch(/invalid receipt_id/);
    expect(updateSeen).toHaveLength(0);
  });
});
