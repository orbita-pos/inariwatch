/**
 * Tests for runVisualDiagnosis — the end-to-end pipeline orchestrator.
 *
 * Mocks the visual-reports service (`getVisualReport`, `updateReportStatus`)
 * and globalThis.fetch (Together API). Verifies:
 *   - Pipeline transitions status through diagnosing → completed
 *   - confidence ≥ 75 ships as 'completed'
 *   - low confidence + unknowns ships as 'need_info'
 *   - Together error → 'failed' with error captured
 *   - Missing PLATFORM_TOGETHER_KEY → 'failed' with clear error
 *   - Re-entrancy guard: row already 'completed' returns without re-running
 *   - Cost math: input + output tokens × per-1M rate / 10000 = cents
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VisualReport } from "@/lib/db";

// vi.hoisted runs BEFORE vi.mock's hoist — gives the mock factory access
// to the function spies at hoist time.
const { mockGetVisualReport, mockUpdateReportStatus } = vi.hoisted(() => ({
  mockGetVisualReport:    vi.fn<(id: string) => Promise<VisualReport | null>>(),
  mockUpdateReportStatus: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("@/lib/services/visual-reports.service", () => ({
  getVisualReport:     mockGetVisualReport,
  updateReportStatus:  mockUpdateReportStatus,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeReport(overrides: Partial<VisualReport> = {}): VisualReport {
  return {
    id:             "report-1",
    alertId:        "alert-1",
    projectId:      "proj-1",
    userId:         null,
    screenshotUrl:  "data:image/webp;base64,XYZ",
    bundleJson:     {
      url: "https://example.com/dashboard",
      userAgent: "TestAgent/1.0",
      viewport: { width: 1280, height: 800, dpr: 2 },
      buildId: "build-xyz",
      capturedAt: Date.now(),
      focused: null,
      console: [],
      network: [],
      captureMs: 100,
      userDescription: "modal won't close",
    },
    bundleHash:     "a".repeat(64),
    captureMs:      100,
    payloadSize:    50000,
    redactionStats: null,
    status:         "pending",
    error:          null,
    triageResult:   null,
    diagnosis:      null,
    critique:       null,
    confidence:     null,
    modelTriage:    null,
    modelDiagnose:  null,
    modelCritique:  null,
    costCents:      0,
    durationMs:     null,
    createdAt:      new Date(),
    updatedAt:      new Date(),
    ...overrides,
  } as VisualReport;
}

function validDiagnosisJson() {
  return {
    root_cause: {
      file:         "web/components/Modal.tsx",
      line:         42,
      function:     "useModal",
      causal_chain: ["a", "b", "c"],
    },
    evidence: [
      { claim: "x", type: "code", source: "repo", quote: "code" },
    ],
    hypotheses_considered: [
      { hypothesis: "h1", score: 9, rejected_because: "" },
      { hypothesis: "h2", score: 5, rejected_because: "reason" },
      { hypothesis: "h3", score: 2, rejected_because: "reason" },
    ],
    confidence:           85,
    unknowns:             [],
    recommended_fix_hint: "Return cleanup from useEffect.",
  };
}

function mockTogetherResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const origFetch = globalThis.fetch;
const origKey   = process.env.PLATFORM_TOGETHER_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLATFORM_TOGETHER_KEY = "tg_test_key";
  globalThis.fetch = origFetch; // tests rebind per-case below
});

// ── Imports AFTER mocks ────────────────────────────────────────────────────

import { runVisualDiagnosis } from "../pipeline";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("runVisualDiagnosis", () => {
  it("happy path: marks status='completed' when confidence ≥ 75", async () => {
    mockGetVisualReport.mockResolvedValue(makeReport());
    mockUpdateReportStatus.mockResolvedValue(undefined);

    globalThis.fetch = vi.fn(async () => mockTogetherResponse({
      choices: [{ message: { content: JSON.stringify(validDiagnosisJson()) } }],
      usage:   { prompt_tokens: 5000, completion_tokens: 800 },
    })) as typeof fetch;

    const result = await runVisualDiagnosis("report-1");

    expect(result.status).toBe("completed");
    expect(result.diagnosis?.root_cause.file).toBe("web/components/Modal.tsx");

    // Status transitions: 'diagnosing' first, then 'completed'.
    const calls = mockUpdateReportStatus.mock.calls;
    expect(calls[0][1]).toBe("diagnosing");
    expect(calls[calls.length - 1][1]).toBe("completed");

    // Last call should have the diagnosis + confidence + cost.
    const finalCall = calls[calls.length - 1];
    const fields = finalCall[2] as { diagnosis: unknown; confidence: number; costCents: number };
    expect(fields.confidence).toBe(85);
    expect(fields.diagnosis).toBeDefined();
    expect(fields.costCents).toBeGreaterThan(0);
  });

  it("low confidence + unknowns populated → 'need_info'", async () => {
    mockGetVisualReport.mockResolvedValue(makeReport());
    mockUpdateReportStatus.mockResolvedValue(undefined);

    const lowConf = validDiagnosisJson();
    lowConf.confidence = 45;
    lowConf.unknowns = ["contents of useModal.ts"];
    lowConf.root_cause.file = "";

    globalThis.fetch = vi.fn(async () => mockTogetherResponse({
      choices: [{ message: { content: JSON.stringify(lowConf) } }],
      usage:   { prompt_tokens: 1000, completion_tokens: 200 },
    })) as typeof fetch;

    const result = await runVisualDiagnosis("report-1");

    expect(result.status).toBe("need_info");
    const calls = mockUpdateReportStatus.mock.calls;
    expect(calls[calls.length - 1][1]).toBe("need_info");
  });

  it("Together 500 → 'failed' with error captured", async () => {
    mockGetVisualReport.mockResolvedValue(makeReport());
    mockUpdateReportStatus.mockResolvedValue(undefined);

    globalThis.fetch = vi.fn(async () =>
      new Response("upstream timeout", { status: 503 })
    ) as typeof fetch;

    const result = await runVisualDiagnosis("report-1");

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/503|timeout/i);
    const calls = mockUpdateReportStatus.mock.calls;
    expect(calls[calls.length - 1][1]).toBe("failed");
  });

  it("malformed JSON from Together → 'failed' with schema error", async () => {
    mockGetVisualReport.mockResolvedValue(makeReport());
    mockUpdateReportStatus.mockResolvedValue(undefined);

    globalThis.fetch = vi.fn(async () => mockTogetherResponse({
      choices: [{ message: { content: "{ not really json }" } }],
    })) as typeof fetch;

    const result = await runVisualDiagnosis("report-1");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/schema|json/i);
  });

  it("missing PLATFORM_TOGETHER_KEY → 'failed' with clear error", async () => {
    delete process.env.PLATFORM_TOGETHER_KEY;
    delete process.env.TOGETHER_API_KEY;
    mockGetVisualReport.mockResolvedValue(makeReport());
    mockUpdateReportStatus.mockResolvedValue(undefined);

    const result = await runVisualDiagnosis("report-1");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/TOGETHER/);
  });

  it("falls back to TOGETHER_API_KEY when PLATFORM_TOGETHER_KEY is unset", async () => {
    delete process.env.PLATFORM_TOGETHER_KEY;
    process.env.TOGETHER_API_KEY = "tg_fallback_key";
    mockGetVisualReport.mockResolvedValue(makeReport());
    mockUpdateReportStatus.mockResolvedValue(undefined);

    let authHeader: string | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      authHeader = (init?.headers as Record<string, string>)?.Authorization;
      return mockTogetherResponse({
        choices: [{ message: { content: JSON.stringify(validDiagnosisJson()) } }],
        usage:   { prompt_tokens: 100, completion_tokens: 50 },
      });
    }) as typeof fetch;

    const result = await runVisualDiagnosis("report-1");
    expect(result.status).toBe("completed");
    expect(authHeader).toBe("Bearer tg_fallback_key");
  });

  it("re-entrancy guard: already-completed report does not re-run pipeline", async () => {
    mockGetVisualReport.mockResolvedValue(makeReport({ status: "completed" }));
    mockUpdateReportStatus.mockResolvedValue(undefined);

    let fetchCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCalls++;
      return mockTogetherResponse({});
    }) as typeof fetch;

    const result = await runVisualDiagnosis("report-1");

    expect(result.status).toBe("completed");
    expect(fetchCalls).toBe(0);
    expect(mockUpdateReportStatus).not.toHaveBeenCalled();
  });

  it("missing report → 'failed' without DB writes", async () => {
    mockGetVisualReport.mockResolvedValue(null);
    mockUpdateReportStatus.mockResolvedValue(undefined);

    const result = await runVisualDiagnosis("report-not-found");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/not found/i);
    expect(mockUpdateReportStatus).not.toHaveBeenCalled();
  });

  it("cost math: 5000 in + 800 out @ $0.60/$3.60 per 1M ≈ 1 cent (rounded up)", async () => {
    mockGetVisualReport.mockResolvedValue(makeReport());
    mockUpdateReportStatus.mockResolvedValue(undefined);

    globalThis.fetch = vi.fn(async () => mockTogetherResponse({
      choices: [{ message: { content: JSON.stringify(validDiagnosisJson()) } }],
      usage:   { prompt_tokens: 5000, completion_tokens: 800 },
    })) as typeof fetch;

    await runVisualDiagnosis("report-1");

    // 5000 × 60 + 800 × 360 = 300,000 + 288,000 = 588,000 (cents × 1M).
    // Real cost = $0.00588 = 0.588¢ → rounds up to 1¢. The column is
    // INTEGER cents; sub-cent calls still bill as the floor of one cent.
    const calls = mockUpdateReportStatus.mock.calls;
    const finalFields = calls[calls.length - 1][2] as { costCents: number };
    expect(finalFields.costCents).toBe(1);
  });
});

// ── Cleanup ────────────────────────────────────────────────────────────────

if (origKey === undefined) {
  delete process.env.PLATFORM_TOGETHER_KEY;
} else {
  process.env.PLATFORM_TOGETHER_KEY = origKey;
}
