/**
 * v0.3 S2.5 — persist-receipt sink unit tests.
 *
 * Verifies the shape that lands in `ai_router_receipts`. We mock the db
 * insert to avoid a real Postgres connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const insertMock = vi.fn();
const valuesMock = vi.fn(async () => undefined);

vi.mock("@/lib/db", () => ({
  db: {
    insert: insertMock,
  },
  aiRouterReceipts: { _name: "ai_router_receipts" },
}));

vi.mock("@inariwatch/ai-router", () => ({
  registerReceiptSink: vi.fn(),
}));

import { persistRouterReceipt } from "@/lib/ai-router/persist-receipt";
import type { RouterReceipt } from "@inariwatch/ai-router";

beforeEach(() => {
  insertMock.mockReset();
  valuesMock.mockReset();
  insertMock.mockReturnValue({ values: valuesMock });
  valuesMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseReceipt = (over: Partial<RouterReceipt> = {}): RouterReceipt => ({
  task: "chat.conversational",
  namespace: "chat",
  substrate: "cloud",
  provider: "openai",
  model: "gpt-4o-mini",
  tsStart: 1_000,
  tsEnd: 1_250,
  workspaceId: "ws-1",
  userId: "u-1",
  isPlatformKey: false,
  fallbackUsed: false,
  relayPath: "direct",
  ...over,
});

describe("persistRouterReceipt", () => {
  it("inserts a row with the right column shape", async () => {
    persistRouterReceipt(baseReceipt());
    // Sink is fire-and-forget — give the microtask a chance to flush.
    await new Promise((r) => setImmediate(r));
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledTimes(1);
    const row = valuesMock.mock.calls[0]![0];
    expect(row.task).toBe("chat.conversational");
    expect(row.substrate).toBe("cloud");
    expect(row.durationMs).toBe(250);
    expect(row.relayPath).toBe("direct");
  });

  it("preserves substrate=user-sidecar + the user-signed receipt blob", async () => {
    const userReceipt = { sig: "deadbeef", payload_hash: "abc" };
    persistRouterReceipt(
      baseReceipt({
        substrate: "user-sidecar",
        relayPath: "relay",
        userSidecarReceipt: userReceipt,
      }),
    );
    await new Promise((r) => setImmediate(r));
    const row = valuesMock.mock.calls[0]![0];
    expect(row.substrate).toBe("user-sidecar");
    expect(row.relayPath).toBe("relay");
    expect(row.userSidecarReceipt).toEqual(userReceipt);
  });

  it("flags fallbackUsed + isPlatformKey", async () => {
    persistRouterReceipt(
      baseReceipt({ fallbackUsed: true, isPlatformKey: true }),
    );
    await new Promise((r) => setImmediate(r));
    const row = valuesMock.mock.calls[0]![0];
    expect(row.fallbackUsed).toBe(true);
    expect(row.isPlatformKey).toBe(true);
  });

  it("never throws even if the insert rejects", async () => {
    valuesMock.mockRejectedValueOnce(new Error("db down"));
    expect(() => persistRouterReceipt(baseReceipt())).not.toThrow();
    await new Promise((r) => setImmediate(r));
    // Receipt failures must be swallowed.
  });
});
