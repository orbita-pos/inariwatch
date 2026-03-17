import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Telegram ───────────────────────────────────────────────────────────

const mockSendTelegram = vi.fn();
vi.mock("../telegram", () => ({
  sendTelegram: (...args: unknown[]) => mockSendTelegram(...args),
}));

const mockSendEmail = vi.fn();
vi.mock("../email", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const mockCheckRateLimit = vi.fn().mockResolvedValue({ allowed: true });
const mockIsEmailSuppressed = vi.fn().mockResolvedValue(false);
vi.mock("../rate-limit", () => ({
  checkEmailRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  isEmailSuppressed: (...args: unknown[]) => mockIsEmailSuppressed(...args),
}));

// ── Mock DB ─────────────────────────────────────────────────────────────────

let queryResults: unknown[][] = [];
let queryIndex = 0;
const insertedValues: unknown[] = [];
const updatedValues: unknown[] = [];

function chainable(result: unknown[]) {
  const chain = {
    from: () => ({
      where: () => {
        const arr = [...result] as unknown[] & {
          limit: (n: number) => unknown[];
          orderBy: (...args: unknown[]) => { limit: (n: number) => unknown[] };
        };
        arr.limit = () => result;
        arr.orderBy = () => ({ limit: () => result });
        return arr;
      },
    }),
  };
  return chain;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => {
      const idx = queryIndex++;
      return chainable(queryResults[idx] ?? []);
    },
    insert: () => ({
      values: (v: unknown) => {
        insertedValues.push(v);
        return {
          returning: () => [{ id: `log-${insertedValues.length}`, ...v as object }],
        };
      },
    }),
    update: () => ({
      set: (v: unknown) => {
        updatedValues.push(v);
        return { where: () => Promise.resolve() };
      },
    }),
  },
  projects: { id: "id", userId: "userId", name: "name" },
  notificationChannels: { id: "id", userId: "userId", isActive: "isActive", verifiedAt: "verifiedAt" },
  notificationLogs: { id: "id", openedAt: "openedAt", clickedAt: "clickedAt" },
  notificationQueue: { id: "id", status: "status", nextRetry: "nextRetry", priority: "priority", createdAt: "createdAt" },
  alerts: { id: "id", projectId: "projectId" },
}));

const { enqueueAlert, notifyAlert } = await import("../send");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAlert(overrides = {}) {
  return {
    id: "alert-1",
    projectId: "proj-1",
    severity: "critical" as const,
    title: "CI failed on main",
    body: "Build #42 failed with exit code 1",
    sourceIntegrations: ["github"],
    aiReasoning: null,
    correlationData: null,
    postmortem: null,
    isRead: false,
    isResolved: false,
    sentAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const telegramChannel = {
  id: "ch-1",
  type: "telegram",
  isActive: true,
  verifiedAt: new Date(),
  config: { bot_token: "123:ABC", chat_id: "456" },
};

const emailChannel = {
  id: "ch-2",
  type: "email",
  isActive: true,
  verifiedAt: new Date(),
  config: { email: "user@test.com" },
};

beforeEach(() => {
  vi.clearAllMocks();
  queryResults = [];
  queryIndex = 0;
  insertedValues.length = 0;
  updatedValues.length = 0;
  mockCheckRateLimit.mockResolvedValue({ allowed: true });
  mockIsEmailSuppressed.mockResolvedValue(false);
});

// ── enqueueAlert ────────────────────────────────────────────────────────────

describe("enqueueAlert", () => {
  it("returns 0 when project not found", async () => {
    queryResults = [[]];
    const result = await enqueueAlert(makeAlert());
    expect(result).toBe(0);
  });

  it("returns 0 when no active channels", async () => {
    queryResults = [
      [{ userId: "user-1", name: "My Project" }],
      [],
    ];
    const result = await enqueueAlert(makeAlert());
    expect(result).toBe(0);
  });

  it("enqueues for each active channel", async () => {
    queryResults = [
      [{ userId: "user-1", name: "My Project" }],
      [telegramChannel, emailChannel],
    ];

    const result = await enqueueAlert(makeAlert());

    expect(result).toBe(2);
    expect(insertedValues.length).toBe(2);
    expect(insertedValues[0]).toMatchObject({
      alertId: "alert-1",
      channelId: "ch-1",
      status: "pending",
    });
  });

  it("sets priority 0 for critical alerts", async () => {
    queryResults = [
      [{ userId: "user-1", name: "My Project" }],
      [telegramChannel],
    ];

    await enqueueAlert(makeAlert({ severity: "critical" }));

    expect(insertedValues[0]).toMatchObject({ priority: 0 });
  });

  it("sets priority 1 for warning alerts", async () => {
    queryResults = [
      [{ userId: "user-1", name: "My Project" }],
      [telegramChannel],
    ];

    await enqueueAlert(makeAlert({ severity: "warning" }));

    expect(insertedValues[0]).toMatchObject({ priority: 1 });
  });

  it("sets priority 2 for info alerts", async () => {
    queryResults = [
      [{ userId: "user-1", name: "My Project" }],
      [telegramChannel],
    ];

    await enqueueAlert(makeAlert({ severity: "info" }));

    expect(insertedValues[0]).toMatchObject({ priority: 2 });
  });

  it("skips inactive channels", async () => {
    queryResults = [
      [{ userId: "user-1", name: "My Project" }],
      [{ ...telegramChannel, isActive: false }],
    ];

    const result = await enqueueAlert(makeAlert());
    expect(result).toBe(0);
  });

  it("skips unverified channels", async () => {
    queryResults = [
      [{ userId: "user-1", name: "My Project" }],
      [{ ...telegramChannel, verifiedAt: null }],
    ];

    const result = await enqueueAlert(makeAlert());
    expect(result).toBe(0);
  });
});

// ── notifyAlert (legacy sync wrapper) ───────────────────────────────────────

describe("notifyAlert", () => {
  it("returns 0 when nothing to send", async () => {
    queryResults = [[]];

    const result = await notifyAlert(makeAlert());
    expect(result).toBe(0);
  });
});
