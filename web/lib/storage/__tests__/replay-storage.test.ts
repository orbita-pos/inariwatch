import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";

// Mock S3 client BEFORE importing storage module.
// vi.mock is hoisted so we can't reference outer variables. Use a hoisted
// helper to share the spy between the mock factory and the test bodies.
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("@aws-sdk/client-s3", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-s3")>("@aws-sdk/client-s3");
  class MockS3Client {
    send = mockSend;
  }
  return {
    ...actual,
    S3Client: MockS3Client,
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://r2.example.com/signed-url"),
}));

import {
  blockKey,
  sessionPrefix,
  uploadBlock,
  fetchBlock,
  getBlockSignedUrl,
  getSessionBlockUrls,
  REPLAY_LIMITS,
} from "../replay-storage";

describe("replay-storage helpers", () => {
  describe("blockKey", () => {
    it("formats block index with zero padding to 4 digits", () => {
      expect(blockKey("org/sess/", 0)).toBe("org/sess/block_0000.json.gz");
      expect(blockKey("org/sess/", 7)).toBe("org/sess/block_0007.json.gz");
      expect(blockKey("org/sess/", 1234)).toBe("org/sess/block_1234.json.gz");
      expect(blockKey("org/sess/", 99999)).toBe("org/sess/block_99999.json.gz");
    });
  });

  describe("sessionPrefix", () => {
    it("builds {org}/{session}/ prefix with trailing slash (legacy 2-arg)", () => {
      expect(sessionPrefix("org_abc", "sess_xyz")).toBe("org_abc/sess_xyz/");
    });

    it("builds the same prefix from { kind: \"org\" } scope", () => {
      expect(sessionPrefix({ kind: "org", organizationId: "org_abc" }, "sess_xyz"))
        .toBe("org_abc/sess_xyz/");
    });

    it("builds users/{userId}/{session}/ from { kind: \"user\" } scope", () => {
      expect(sessionPrefix({ kind: "user", userId: "user_42" }, "sess_xyz"))
        .toBe("users/user_42/sess_xyz/");
    });

    it("user prefix is unambiguous vs org prefix (different first segment)", () => {
      const orgKey = sessionPrefix({ kind: "org", organizationId: "user_42" }, "sess_xyz");
      const userKey = sessionPrefix({ kind: "user", userId: "user_42" }, "sess_xyz");
      expect(orgKey).not.toBe(userKey);
      expect(orgKey).toBe("user_42/sess_xyz/");
      expect(userKey).toBe("users/user_42/sess_xyz/");
    });
  });

  describe("REPLAY_LIMITS", () => {
    it("exposes hard limits", () => {
      expect(REPLAY_LIMITS.BLOCK_DURATION_MS).toBe(30_000);
      expect(REPLAY_LIMITS.MAX_BLOCK_BYTES_RAW).toBe(1_048_576);
      expect(REPLAY_LIMITS.MAX_BLOCK_EVENTS).toBe(10_000);
    });
  });
});

describe("uploadBlock", () => {
  beforeEach(() => {
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.R2_BUCKET = "test-bucket";
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_BUCKET;
  });

  it("rejects blocks with too many events", async () => {
    const events = Array.from({ length: REPLAY_LIMITS.MAX_BLOCK_EVENTS + 1 }, (_, i) => ({ i }));
    await expect(uploadBlock({
      scope: { kind: "org", organizationId: "org" },
      sessionId: "sess",
      blockIndex: 0,
      startMs: 0,
      endMs: 1000,
      events,
    })).rejects.toThrow(/exceeds max .* events/);
  });

  it("rejects blocks larger than 1 MB raw", async () => {
    // Each event ~150 bytes when stringified. Need ~7000 to exceed 1 MB.
    const big = "x".repeat(150);
    const events = Array.from({ length: 8000 }, () => ({ payload: big }));
    await expect(uploadBlock({
      scope: { kind: "org", organizationId: "org" },
      sessionId: "sess",
      blockIndex: 0,
      startMs: 0,
      endMs: 1000,
      events,
    })).rejects.toThrow(/exceeds max .* bytes/);
  });

  it("uploads org-scoped block with gzip + correct key + reports compressed bytes", async () => {
    const events = [{ type: 1, data: { hello: "world" } }, { type: 2, data: { foo: "bar" } }];
    const result = await uploadBlock({
      scope: { kind: "org", organizationId: "org_a" },
      sessionId: "sess_b",
      blockIndex: 3,
      startMs: 0,
      endMs: 30_000,
      events,
    });

    expect(result.key).toBe("org_a/sess_b/block_0003.json.gz");
    expect(result.bytes).toBeGreaterThan(0);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const callArg = mockSend.mock.calls[0][0];
    expect(callArg.input.Bucket).toBe("test-bucket");
    expect(callArg.input.Key).toBe("org_a/sess_b/block_0003.json.gz");
    expect(callArg.input.ContentType).toBe("application/json");
    expect(callArg.input.ContentEncoding).toBe("gzip");

    // Verify body is gzipped JSON of events
    const decompressed = gunzipSync(callArg.input.Body).toString("utf8");
    expect(JSON.parse(decompressed)).toEqual(events);
  });

  it("uploads user-scoped (personal) block under users/<id>/ prefix", async () => {
    const events = [{ type: 4, data: {} }];
    const result = await uploadBlock({
      scope: { kind: "user", userId: "user_42" },
      sessionId: "sess_personal",
      blockIndex: 0,
      startMs: 0,
      endMs: 30_000,
      events,
    });

    expect(result.key).toBe("users/user_42/sess_personal/block_0000.json.gz");
    const callArg = mockSend.mock.calls[0][0];
    expect(callArg.input.Key).toBe("users/user_42/sess_personal/block_0000.json.gz");
  });

  it("throws if R2 env vars are missing", async () => {
    delete process.env.R2_ACCOUNT_ID;
    // Re-import to clear cached client (need fresh module)
    vi.resetModules();
    const { uploadBlock: freshUpload } = await import("../replay-storage");
    await expect(freshUpload({
      scope: { kind: "org", organizationId: "o" },
      sessionId: "s",
      blockIndex: 0,
      startMs: 0,
      endMs: 1,
      events: [{}],
    })).rejects.toThrow(/R2 not configured/);
  });
});

describe("fetchBlock", () => {
  beforeEach(() => {
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.R2_BUCKET = "test-bucket";
    mockSend.mockReset();
  });

  it("decompresses gzip body and returns parsed events", async () => {
    const events = [{ type: 1 }, { type: 2 }];
    const compressed = gzipSync(JSON.stringify(events));
    mockSend.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array(compressed) },
    });

    vi.resetModules();
    const { fetchBlock: freshFetch } = await import("../replay-storage");
    const result = await freshFetch("org/sess/block_0000.json.gz");
    expect(result).toEqual(events);
  });
});

describe("getBlockSignedUrl + getSessionBlockUrls", () => {
  beforeEach(() => {
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.R2_BUCKET = "test-bucket";
    mockSend.mockReset();
  });

  it("getSessionBlockUrls produces one URL per block with correct ms ranges", async () => {
    vi.resetModules();
    const { getSessionBlockUrls: fresh } = await import("../replay-storage");
    const blocks = await fresh("org_x", "sess_y", 3, 60);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ index: 0, startMs: 0, endMs: 30_000 });
    expect(blocks[1]).toMatchObject({ index: 1, startMs: 30_000, endMs: 60_000 });
    expect(blocks[2]).toMatchObject({ index: 2, startMs: 60_000, endMs: 90_000 });
    blocks.forEach((b) => expect(b.url).toBe("https://r2.example.com/signed-url"));
  });
});
