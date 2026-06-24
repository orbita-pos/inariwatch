/**
 * Unit tests for the structured slash-command handlers.
 *
 * Each handler is exercised against a mocked `invoke` (tool-routed)
 * or `cloudIpc` (cloud-IPC-routed) and we assert on:
 *   1. arg parsing — error branches push the right hint, valid args
 *      reach the underlying IPC verbatim;
 *   2. value rendering — the assistant note contains the markdown
 *      shape we promise (headers, tables, fields);
 *   3. error handling — IPC failure surfaces as a `… failed: <msg>`
 *      note without throwing.
 *
 * Rendering tests assert on substring presence rather than the full
 * string so Phase 4 polish (icons, colors, layout tweaks) doesn't
 * cascade-break tests.
 */

import { describe, expect, it, vi } from "vitest";

import {
  handleAlert,
  handleAlerts,
  handleDigest,
  handleHealth,
  handleOncall,
  handleProjects,
  handleSearch,
  handleUptime,
  parseAlertArgs,
  parseAlertsArgs,
  parseHealthArgs,
  parseProjectsArgs,
  parseSearchArgs,
  renderAlertCard,
  renderAlerts,
  renderDigest,
  renderHealth,
  renderOncall,
  renderProjects,
  renderSearch,
  renderUptime,
  type SlashCloudIpc,
  type SlashHandlerCtx,
} from "../handlers";
import type {
  CloudAlert,
  OncallStatus,
  UptimeSummary,
} from "../../cloud-ipc";
import type { ChatMessage } from "../../store/chat";
import type { InvokeOutcome } from "../../tool-invoke-ipc";

// ── Test plumbing ──────────────────────────────────────────────────────────

function makeCtx(
  invoke?: SlashHandlerCtx["invoke"],
  cloudIpc?: SlashCloudIpc,
): { ctx: SlashHandlerCtx; pushed: ChatMessage[] } {
  const pushed: ChatMessage[] = [];
  return {
    ctx: {
      appendMessage: (m) => {
        pushed.push(m);
      },
      sessionId: "test-session",
      invoke,
      cloudIpc,
    },
    pushed,
  };
}

const okOutcome = (value: unknown): InvokeOutcome => ({
  kind: "output",
  invocation_id: "inv-test",
  output: { value, summary: null },
  permission: "auto",
});

const deniedOutcome = (reason: string): InvokeOutcome => ({
  kind: "denied",
  tool: "cloud.list_projects",
  reason,
});

const confirmOutcome = (): InvokeOutcome => ({
  kind: "requires_confirm",
  tool: "cloud.list_projects",
  permission: "confirm",
});

// Tiny fixtures ----------------------------------------------------------

const alertFixture = (over: Partial<CloudAlert> = {}): CloudAlert => ({
  id: "a1",
  title: "TypeError in /api/foo",
  body: null,
  severity: "critical",
  aiReasoning: null,
  sourceIntegrations: ["sentry"],
  projectName: "Web",
  fingerprint: "fp-1",
  inariHash: "1a2b3c4d5e6f7890",
  isRead: false,
  isResolved: false,
  createdAt: new Date().toISOString(),
  ...over,
});

// ───────────────────────────────────────────────────────────────────────────
// /projects
// ───────────────────────────────────────────────────────────────────────────

describe("parseProjectsArgs", () => {
  it("returns empty args when no input", () => {
    expect(parseProjectsArgs("")).toEqual({ args: {} });
    expect(parseProjectsArgs("   ")).toEqual({ args: {} });
  });

  it("parses --integration=<svc>", () => {
    expect(parseProjectsArgs("--integration=capture")).toEqual({
      args: { integration: "capture" },
    });
    expect(parseProjectsArgs("  --integration=vercel  ")).toEqual({
      args: { integration: "vercel" },
    });
  });

  it("accepts --<svc> shorthand for known integrations", () => {
    expect(parseProjectsArgs("--capture")).toEqual({
      args: { integration: "capture" },
    });
    expect(parseProjectsArgs("--github")).toEqual({
      args: { integration: "github" },
    });
  });

  it("rejects unknown integration values", () => {
    const result = parseProjectsArgs("--integration=bogus");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/Unknown integration/);
    }
  });

  it("rejects positional args (no integration flag)", () => {
    const result = parseProjectsArgs("capture");
    expect("error" in result).toBe(true);
  });
});

describe("renderProjects", () => {
  it("renders 'none' message when empty", () => {
    const out = renderProjects({ projects: [] });
    expect(out).toMatch(/Projects.*none/i);
  });

  it("renders a markdown table with each project's fields", () => {
    const out = renderProjects({
      projects: [
        {
          id: "p1-uuid-12345678",
          name: "Web",
          state: "live",
          workspaceName: "BERNAL ORG",
          integrations: ["vercel", "capture"],
        },
      ],
    });
    expect(out).toMatch(/Web/);
    expect(out).toMatch(/live/);
    expect(out).toMatch(/BERNAL ORG/);
    expect(out).toMatch(/vercel, capture/);
    expect(out).toMatch(/\| Name \| State \| Workspace \| Integrations \| ID \|/);
  });

  it("notes the integration filter in the title when present", () => {
    const out = renderProjects(
      { projects: [{ id: "p1", name: "Web", state: "live", workspaceName: "ws", integrations: ["capture"] }] },
      "capture",
    );
    expect(out).toMatch(/with `capture`/);
  });
});

describe("handleProjects", () => {
  it("invokes cloud.list_projects with parsed integration filter", async () => {
    const invoke = vi.fn().mockResolvedValue(
      okOutcome({
        projects: [
          {
            id: "p-demo",
            name: "DEMO",
            state: "live",
            workspaceName: "BERNAL",
            integrations: ["capture"],
          },
        ],
      }),
    );
    const { ctx, pushed } = makeCtx(invoke);
    await handleProjects({ command: "projects", args: "--integration=capture" }, ctx);
    expect(invoke).toHaveBeenCalledWith(
      "cloud.list_projects",
      { integration: "capture" },
      "test-session",
    );
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.content).toMatch(/DEMO/);
    expect(pushed[0]?.content).toMatch(/capture/);
  });

  it("invokes with empty args when no filter", async () => {
    const invoke = vi.fn().mockResolvedValue(okOutcome({ projects: [] }));
    const { ctx } = makeCtx(invoke);
    await handleProjects({ command: "projects", args: "" }, ctx);
    expect(invoke).toHaveBeenCalledWith("cloud.list_projects", {}, "test-session");
  });

  it("surfaces parse errors without invoking", async () => {
    const invoke = vi.fn();
    const { ctx, pushed } = makeCtx(invoke);
    await handleProjects({ command: "projects", args: "garbage" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed[0]?.content).toMatch(/\/projects/);
  });

  it("surfaces denied outcomes as the backend's reason verbatim", async () => {
    const invoke = vi.fn().mockResolvedValue(deniedOutcome("Tool denied — set in Settings → Permissions"));
    const { ctx, pushed } = makeCtx(invoke);
    await handleProjects({ command: "projects", args: "" }, ctx);
    expect(pushed[0]?.content).toMatch(/Tool denied/);
  });

  it("surfaces requires_confirm as a slash-bypass bug message", async () => {
    const invoke = vi.fn().mockResolvedValue(confirmOutcome());
    const { ctx, pushed } = makeCtx(invoke);
    await handleProjects({ command: "projects", args: "" }, ctx);
    expect(pushed[0]?.content).toMatch(/requires_confirm/);
  });

  it("surfaces IPC throws as a failure note", async () => {
    const invoke = vi.fn().mockRejectedValue({ message: "network down" });
    const { ctx, pushed } = makeCtx(invoke);
    await handleProjects({ command: "projects", args: "" }, ctx);
    expect(pushed[0]?.content).toMatch(/failed.*network down/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /health
// ───────────────────────────────────────────────────────────────────────────

describe("parseHealthArgs", () => {
  it("requires a project_id", () => {
    const r = parseHealthArgs("");
    expect("error" in r).toBe(true);
  });

  it("rejects path-traversal-shaped ids", () => {
    const r = parseHealthArgs("../alerts");
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toMatch(/plain UUID/);
    }
  });

  it("accepts plain ids", () => {
    expect(parseHealthArgs("p-abc-123")).toEqual({
      args: { project_id: "p-abc-123" },
    });
  });
});

describe("renderHealth", () => {
  it("renders state icon + alert counts + uptime + integrations", () => {
    const out = renderHealth({
      projectName: "Web",
      state: "warning",
      alerts24h: { total: 3, critical: 0, warning: 2, info: 1 },
      uptime: { monitorsTotal: 2, monitorsDown: 0, avgResponseMs: 187 },
      lastDeploy: null,
      integrations: ["vercel", "capture"],
    });
    expect(out).toMatch(/Web/);
    expect(out).toMatch(/warning/);
    expect(out).toMatch(/2 warning/);
    expect(out).toMatch(/all up ✅/);
    expect(out).toMatch(/187ms/);
    expect(out).toMatch(/vercel, capture/);
  });

  it("renders 'none ✅' for zero alerts", () => {
    const out = renderHealth({
      projectName: "Web",
      state: "live",
      alerts24h: { total: 0, critical: 0, warning: 0, info: 0 },
      uptime: { monitorsTotal: 1, monitorsDown: 0, avgResponseMs: null },
      integrations: [],
    });
    expect(out).toMatch(/none ✅/);
  });
});

describe("handleHealth", () => {
  it("invokes cloud.get_project_health with the project_id", async () => {
    const invoke = vi.fn().mockResolvedValue(
      okOutcome({
        projectName: "Web",
        state: "live",
        alerts24h: { total: 0, critical: 0, warning: 0, info: 0 },
        uptime: { monitorsTotal: 1, monitorsDown: 0 },
        integrations: ["capture"],
      }),
    );
    const { ctx, pushed } = makeCtx(invoke);
    await handleHealth({ command: "health", args: "p-uuid-1" }, ctx);
    expect(invoke).toHaveBeenCalledWith(
      "cloud.get_project_health",
      { project_id: "p-uuid-1" },
      "test-session",
    );
    expect(pushed[0]?.content).toMatch(/Web/);
  });

  it("rejects missing project_id without invoking", async () => {
    const invoke = vi.fn();
    const { ctx, pushed } = makeCtx(invoke);
    await handleHealth({ command: "health", args: "" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed[0]?.content).toMatch(/\/health/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /digest
// ───────────────────────────────────────────────────────────────────────────

describe("renderDigest", () => {
  it("renders an all-clear digest when no critical alerts or downs", () => {
    const out = renderDigest({
      totalAlerts24h: 0,
      alertsCritical24h: 0,
      alertsWarning24h: 0,
      monitorsDown: 0,
      monitorsTotal: 4,
      projectCount: 3,
    });
    expect(out).toMatch(/all clear/);
    expect(out).toMatch(/all up ✅/);
  });

  it("flags attention when critical alerts exist", () => {
    const out = renderDigest({
      totalAlerts24h: 5,
      alertsCritical24h: 2,
      alertsWarning24h: 3,
      monitorsDown: 0,
      monitorsTotal: 4,
      projectCount: 3,
      topNoisyProject: { name: "Web", alerts24h: 4 },
    });
    expect(out).toMatch(/attention/);
    expect(out).toMatch(/2 critical/);
    expect(out).toMatch(/Web/);
  });
});

describe("handleDigest", () => {
  it("invokes cloud.get_workspace_summary with no args", async () => {
    const invoke = vi.fn().mockResolvedValue(
      okOutcome({
        totalAlerts24h: 0,
        alertsCritical24h: 0,
        alertsWarning24h: 0,
        monitorsDown: 0,
        monitorsTotal: 1,
        projectCount: 1,
      }),
    );
    const { ctx } = makeCtx(invoke);
    await handleDigest({ command: "digest", args: "" }, ctx);
    expect(invoke).toHaveBeenCalledWith(
      "cloud.get_workspace_summary",
      {},
      "test-session",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /search
// ───────────────────────────────────────────────────────────────────────────

describe("parseSearchArgs", () => {
  it("requires a query", () => {
    expect("error" in parseSearchArgs("")).toBe(true);
  });

  it("forwards the query as error_text", () => {
    expect(parseSearchArgs("EADDRINUSE")).toEqual({
      args: { error_text: "EADDRINUSE" },
    });
  });

  it("rejects queries > 8 KB", () => {
    const huge = "x".repeat(9000);
    expect("error" in parseSearchArgs(huge)).toBe(true);
  });
});

describe("renderSearch", () => {
  it("renders 'no hits' when empty", () => {
    const out = renderSearch({ results: [] }, "anything");
    expect(out).toMatch(/no hits/);
  });

  it("renders hits as a markdown ordered list with source tags", () => {
    const out = renderSearch(
      {
        results: [
          { title: "Why does EADDRINUSE happen?", url: "https://so.com/q/1", source: "stackoverflow" },
          { title: "Fix port conflict", url: "https://github.com/x/y/issues/42", source: "github" },
        ],
      },
      "EADDRINUSE",
    );
    expect(out).toMatch(/EADDRINUSE/);
    expect(out).toMatch(/2 hits/);
    expect(out).toMatch(/stackoverflow/);
    expect(out).toMatch(/github/);
    expect(out).toMatch(/\[Why does EADDRINUSE happen\?\]\(https:\/\/so\.com\/q\/1\)/);
  });
});

describe("handleSearch", () => {
  it("invokes search.error_context with the query", async () => {
    const invoke = vi.fn().mockResolvedValue(okOutcome({ results: [] }));
    const { ctx } = makeCtx(invoke);
    await handleSearch({ command: "search", args: "TypeError" }, ctx);
    expect(invoke).toHaveBeenCalledWith(
      "search.error_context",
      { error_text: "TypeError" },
      "test-session",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /alerts
// ───────────────────────────────────────────────────────────────────────────

describe("parseAlertsArgs", () => {
  it("defaults to limit 20", () => {
    expect(parseAlertsArgs("")).toEqual({ args: { limit: 20 } });
  });

  it("accepts explicit positive integer limits", () => {
    expect(parseAlertsArgs("50")).toEqual({ args: { limit: 50 } });
  });

  it("caps at 100", () => {
    expect("error" in parseAlertsArgs("9999")).toBe(true);
  });

  it("rejects non-numeric limits", () => {
    expect("error" in parseAlertsArgs("foo")).toBe(true);
  });
});

describe("renderAlerts", () => {
  it("renders 'none active ✅' when no active alerts", () => {
    const out = renderAlerts([alertFixture({ isResolved: true })]);
    expect(out).toMatch(/none active ✅/);
  });

  it("renders a markdown table with severity tally + hash column", () => {
    const out = renderAlerts([
      alertFixture({ severity: "critical" }),
      alertFixture({ severity: "warning", id: "a2", inariHash: "abcdef1234567890" }),
    ]);
    expect(out).toMatch(/1 critical/);
    expect(out).toMatch(/1 warning/);
    expect(out).toMatch(/\| Title \| Project \| Age \| Hash \|/);
    expect(out).toMatch(/`1a2b3c4d`/);
    expect(out).toMatch(/`abcdef12`/);
  });
});

describe("handleAlerts", () => {
  it("calls cloudIpc.getAlerts with the parsed limit", async () => {
    const cloudIpc: SlashCloudIpc = {
      getAlerts: vi.fn().mockResolvedValue([alertFixture()]),
      getUptime: vi.fn(),
      getOncall: vi.fn(),
    };
    const { ctx, pushed } = makeCtx(undefined, cloudIpc);
    await handleAlerts({ command: "alerts", args: "50" }, ctx);
    expect(cloudIpc.getAlerts).toHaveBeenCalledWith(50);
    expect(pushed[0]?.content).toMatch(/critical/);
  });

  it("surfaces IPC failures as a clear note", async () => {
    const cloudIpc: SlashCloudIpc = {
      getAlerts: vi.fn().mockRejectedValue(new Error("net down")),
      getUptime: vi.fn(),
      getOncall: vi.fn(),
    };
    const { ctx, pushed } = makeCtx(undefined, cloudIpc);
    await handleAlerts({ command: "alerts", args: "" }, ctx);
    expect(pushed[0]?.content).toMatch(/failed.*net down/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /alert <hash>
// ───────────────────────────────────────────────────────────────────────────

describe("parseAlertArgs", () => {
  it("requires a hash", () => {
    expect("error" in parseAlertArgs("")).toBe(true);
  });

  it("accepts bare 16-hex suffix", () => {
    expect(parseAlertArgs("1a2b3c4d5e6f7890")).toEqual({
      args: { hash: "1a2b3c4d5e6f7890" },
    });
  });

  it("strips inari:alert: prefix", () => {
    expect(parseAlertArgs("inari:alert:1a2b3c4d5e6f7890")).toEqual({
      args: { hash: "1a2b3c4d5e6f7890" },
    });
  });

  it("rejects non-hex input", () => {
    expect("error" in parseAlertArgs("not-a-hash")).toBe(true);
  });
});

describe("renderAlertCard", () => {
  it("renders a single alert with hash + body fallback", () => {
    const out = renderAlertCard(
      alertFixture({
        title: "TypeError in foo",
        aiReasoning: null,
        body: "Stack trace lines here.",
      }),
    );
    expect(out).toMatch(/TypeError in foo/);
    expect(out).toMatch(/inari:alert:1a2b3c4d5e6f7890/);
    expect(out).toMatch(/Body/);
    expect(out).toMatch(/Stack trace/);
  });

  it("prefers AI reasoning when present", () => {
    const out = renderAlertCard(
      alertFixture({
        aiReasoning: "The handler dereferences `req.body` before parsing.",
        body: "raw body",
      }),
    );
    expect(out).toMatch(/AI analysis/);
    expect(out).not.toMatch(/raw body/);
  });
});

describe("handleAlert", () => {
  it("looks up matching alert from the recent window", async () => {
    const cloudIpc: SlashCloudIpc = {
      getAlerts: vi.fn().mockResolvedValue([
        alertFixture({ inariHash: "1111111111111111", title: "Other alert", id: "x1" }),
        alertFixture({ inariHash: "1a2b3c4d5e6f7890", title: "Target alert", id: "x2" }),
      ]),
      getUptime: vi.fn(),
      getOncall: vi.fn(),
    };
    const { ctx, pushed } = makeCtx(undefined, cloudIpc);
    await handleAlert({ command: "alert", args: "1a2b3c4d" }, ctx);
    expect(pushed[0]?.content).toMatch(/Target alert/);
  });

  it("reports 'no match' when the hash isn't in the window", async () => {
    const cloudIpc: SlashCloudIpc = {
      getAlerts: vi.fn().mockResolvedValue([
        alertFixture({ inariHash: "1111111111111111" }),
      ]),
      getUptime: vi.fn(),
      getOncall: vi.fn(),
    };
    const { ctx, pushed } = makeCtx(undefined, cloudIpc);
    await handleAlert({ command: "alert", args: "deadbeef" }, ctx);
    expect(pushed[0]?.content).toMatch(/no alert in the last 100/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /uptime
// ───────────────────────────────────────────────────────────────────────────

describe("renderUptime", () => {
  it("renders 'no monitors' for empty list", () => {
    const out = renderUptime({ monitors: [], downCount: 0, total: 0, avgResponseMs: null });
    expect(out).toMatch(/no monitors/);
  });

  it("renders rows with down marker + avg", () => {
    const summary: UptimeSummary = {
      monitors: [
        {
          id: "m1",
          name: "Web",
          url: "https://web.example.com",
          isDown: false,
          consecutiveFailures: 0,
          lastCheckedAt: new Date().toISOString(),
          lastResponseTimeMs: 200,
        },
        {
          id: "m2",
          name: "API",
          url: "https://api.example.com",
          isDown: true,
          consecutiveFailures: 3,
          lastCheckedAt: new Date().toISOString(),
          lastResponseTimeMs: null,
        },
      ],
      downCount: 1,
      total: 2,
      avgResponseMs: 200,
    };
    const out = renderUptime(summary);
    expect(out).toMatch(/1 down/);
    expect(out).toMatch(/avg 200ms/);
    expect(out).toMatch(/Web/);
    expect(out).toMatch(/API/);
    expect(out).toMatch(/3 failures/);
  });
});

describe("handleUptime", () => {
  it("calls cloudIpc.getUptime", async () => {
    const cloudIpc: SlashCloudIpc = {
      getAlerts: vi.fn(),
      getUptime: vi.fn().mockResolvedValue({
        monitors: [],
        downCount: 0,
        total: 0,
        avgResponseMs: null,
      }),
      getOncall: vi.fn(),
    };
    const { ctx } = makeCtx(undefined, cloudIpc);
    await handleUptime({ command: "uptime", args: "" }, ctx);
    expect(cloudIpc.getUptime).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /oncall
// ───────────────────────────────────────────────────────────────────────────

describe("renderOncall", () => {
  it("renders 'no schedules' for empty list", () => {
    const out = renderOncall({ schedules: [], totalAssignments: 0 });
    expect(out).toMatch(/no schedules/);
  });

  it("renders a table with primary/secondary names", () => {
    const status: OncallStatus = {
      schedules: [
        {
          projectId: "p1",
          projectName: "Web",
          scheduleName: "primary",
          timezone: "UTC",
          primary: { userId: "u1", name: "Alice", email: "a@x.com" },
          secondary: { userId: "u2", name: "Bob", email: "b@x.com" },
          hasActiveOverride: false,
        },
      ],
      totalAssignments: 2,
    };
    const out = renderOncall(status);
    expect(out).toMatch(/Alice/);
    expect(out).toMatch(/Bob/);
    expect(out).toMatch(/Web/);
    expect(out).toMatch(/Primary/);
  });

  it("marks override schedules with a refresh emoji", () => {
    const status: OncallStatus = {
      schedules: [
        {
          projectId: "p1",
          projectName: "Web",
          scheduleName: "primary",
          timezone: "UTC",
          primary: { userId: "u1", name: "Alice", email: null },
          secondary: null,
          hasActiveOverride: true,
        },
      ],
      totalAssignments: 1,
    };
    const out = renderOncall(status);
    expect(out).toMatch(/🔄/);
  });
});

describe("handleOncall", () => {
  it("calls cloudIpc.getOncall", async () => {
    const cloudIpc: SlashCloudIpc = {
      getAlerts: vi.fn(),
      getUptime: vi.fn(),
      getOncall: vi.fn().mockResolvedValue({ schedules: [], totalAssignments: 0 }),
    };
    const { ctx } = makeCtx(undefined, cloudIpc);
    await handleOncall({ command: "oncall", args: "" }, ctx);
    expect(cloudIpc.getOncall).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 5.3 — scoped-memory summary helpers
// ───────────────────────────────────────────────────────────────────────────

describe("summarizeAlerts() — rich summary with inline IDs + discriminator", () => {
  it("returns 'no active alerts' on empty input", async () => {
    const { summarizeAlerts } = await import("../handlers");
    expect(summarizeAlerts([])).toBe("no active alerts");
  });

  it("inlines `inari:alert:<hash>` reference + title + HH:MM time", async () => {
    const { summarizeAlerts } = await import("../handlers");
    const summary = summarizeAlerts([
      alertFixture({
        inariHash: "1a2b3c4d5e6f7890",
        title: "payment timeout",
        createdAt: "2026-05-15T12:01:30.000Z",
        severity: "critical",
      }),
      alertFixture({
        inariHash: "5e6f78901234abcd",
        title: "DB pool exhausted",
        createdAt: "2026-05-15T11:58:00.000Z",
        severity: "critical",
      }),
    ]);
    // Headline + counts
    expect(summary).toContain("2 active");
    expect(summary).toContain("2 critical");
    // Per-entity inline refs
    expect(summary).toContain("inari:alert:1a2b3c4d");
    expect(summary).toContain("payment timeout");
    expect(summary).toContain("12:01");
    expect(summary).toContain("inari:alert:5e6f7890");
    expect(summary).toContain("DB pool exhausted");
    expect(summary).toContain("11:58");
  });

  it("falls back to raw id when inariHash is null", async () => {
    const { summarizeAlerts } = await import("../handlers");
    const summary = summarizeAlerts([
      alertFixture({ id: "raw-abc", inariHash: null, title: "legacy" }),
    ]);
    expect(summary).toContain("raw-abc");
    expect(summary).not.toContain("inari:alert:");
  });

  it("caps at 5 entries with a '(+N more)' tail", async () => {
    const { summarizeAlerts } = await import("../handlers");
    const many = Array.from({ length: 8 }, (_, i) =>
      alertFixture({ id: `a-${i}`, inariHash: null, title: `t${i}` }),
    );
    const summary = summarizeAlerts(many);
    expect(summary).toContain("a-0");
    expect(summary).toContain("a-4");
    expect(summary).not.toContain("a-5"); // not inlined
    expect(summary).toContain("(+3 more)");
  });

  it("truncates long titles to keep the summary on one line", async () => {
    const { summarizeAlerts } = await import("../handlers");
    const summary = summarizeAlerts([
      alertFixture({
        inariHash: null,
        id: "x",
        title: "a".repeat(120),
      }),
    ]);
    // After truncate(60), the substring "aaa…" must be present with the
    // ellipsis ON the line. Total title rendered should be ≤ 60 chars.
    expect(summary).toContain("…");
  });

  it("uses the lone severity bucket in the count line", async () => {
    const { summarizeAlerts } = await import("../handlers");
    const summary = summarizeAlerts([
      alertFixture({ severity: "warning", inariHash: null, id: "w" }),
      alertFixture({ severity: "warning", inariHash: null, id: "w2" }),
    ]);
    expect(summary).toContain("2 active");
    expect(summary).toContain("2 warning");
    expect(summary).not.toContain("critical");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 5.7 — /fix
// ───────────────────────────────────────────────────────────────────────────

describe("parseFixArgs", () => {
  it("rejects empty / whitespace input", async () => {
    const { parseFixArgs } = await import("../handlers");
    expect("error" in parseFixArgs("")).toBe(true);
    expect("error" in parseFixArgs("   ")).toBe(true);
  });

  it("accepts bare 16-hex suffix", async () => {
    const { parseFixArgs } = await import("../handlers");
    const result = parseFixArgs("1a2b3c4d5e6f7890");
    if ("error" in result) throw new Error(result.error);
    expect(result.args.hash).toBe("1a2b3c4d5e6f7890");
  });

  it("strips the `inari:alert:` prefix", async () => {
    const { parseFixArgs } = await import("../handlers");
    const result = parseFixArgs("inari:alert:DEADBEEFDEADBEEF");
    if ("error" in result) throw new Error(result.error);
    expect(result.args.hash).toBe("deadbeefdeadbeef");
  });

  it("rejects non-hex characters", async () => {
    const { parseFixArgs } = await import("../handlers");
    expect("error" in parseFixArgs("not-hex")).toBe(true);
  });

  it("rejects hashes shorter than 4 hex chars", async () => {
    const { parseFixArgs } = await import("../handlers");
    expect("error" in parseFixArgs("ab")).toBe(true);
  });
});

describe("renderFixQueued", () => {
  it("references the alert by its full inari:alert: hash", async () => {
    const { renderFixQueued } = await import("../handlers");
    const out = renderFixQueued(alertFixture({ inariHash: "abcd1234abcd1234" }));
    expect(out).toContain("inari:alert:abcd1234abcd1234");
    expect(out).toContain("Remediation queued");
  });

  it("falls back to the raw id when inariHash is null", async () => {
    const { renderFixQueued } = await import("../handlers");
    const out = renderFixQueued(
      alertFixture({ id: "raw-id", inariHash: null }),
    );
    expect(out).toContain("raw-id");
  });
});

describe("handleFix", () => {
  it("suspends with alert slot when no args are provided + onSuspended is wired", async () => {
    const { handleFix } = await import("../handlers");
    const captured: Array<{ needs: { kind: string; name: string }; rebuilt: string }> = [];
    const { ctx } = makeCtx();
    ctx.onSuspended = (state) => {
      captured.push({
        needs: { kind: state.needs.kind, name: state.needs.name },
        rebuilt: state.rebuild({
          ...state.partial.collectedArgs,
          hash: "abc123",
        }),
      });
    };
    await handleFix({ command: "fix", args: "" }, ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.needs.kind).toBe("alert");
    expect(captured[0]!.needs.name).toBe("hash");
  });

  it("suspends instead of erroring when the hash is malformed + onSuspended is wired", async () => {
    const { handleFix } = await import("../handlers");
    const captured: Array<{ needs: { kind: string } }> = [];
    const { ctx } = makeCtx();
    ctx.onSuspended = (state) => {
      captured.push({ needs: { kind: state.needs.kind } });
    };
    await handleFix({ command: "fix", args: "not-hex" }, ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.needs.kind).toBe("alert");
  });

  it("looks up the alert and pushes a 'remediation queued' note on the happy path", async () => {
    const { handleFix } = await import("../handlers");
    const cloudIpc: SlashCloudIpc = {
      getAlerts: vi.fn().mockResolvedValue([
        alertFixture({
          inariHash: "1a2b3c4d5e6f7890",
          title: "payment timeout",
        }),
      ]),
      getUptime: vi.fn(),
      getOncall: vi.fn(),
    };
    const { ctx, pushed } = makeCtx(undefined, cloudIpc);
    await handleFix({ command: "fix", args: "1a2b3c4d" }, ctx);
    const note = pushed.find((m) => m.role === "assistant");
    expect(note?.content).toContain("Remediation queued");
    expect(note?.content).toContain("inari:alert:1a2b3c4d5e6f7890");
    expect(note?.content).toContain("payment timeout");
  });

  it("legacy path (no onSuspended) surfaces the parse error", async () => {
    const { handleFix } = await import("../handlers");
    const { ctx, pushed } = makeCtx();
    await handleFix({ command: "fix", args: "" }, ctx);
    const note = pushed.find((m) => m.role === "assistant");
    expect(note?.content).toMatch(/Inari hash required/i);
  });

  it("no match in last 100 alerts → 'no alert' note", async () => {
    const { handleFix } = await import("../handlers");
    const cloudIpc: SlashCloudIpc = {
      getAlerts: vi.fn().mockResolvedValue([
        alertFixture({ inariHash: "different00000000" }),
      ]),
      getUptime: vi.fn(),
      getOncall: vi.fn(),
    };
    const { ctx, pushed } = makeCtx(undefined, cloudIpc);
    await handleFix({ command: "fix", args: "1a2b" }, ctx);
    const note = pushed.find((m) => m.role === "assistant");
    expect(note?.content).toContain("no alert in the last 100");
  });
});

describe("fixRebuild", () => {
  it("emits `/fix <hash>` from the `hash` slot value", async () => {
    const { fixRebuild } = await import("../handlers");
    expect(fixRebuild({ hash: "abc" })).toBe("/fix abc");
  });

  it("falls back to alert_hash companion (set by mergeSlotValue)", async () => {
    const { fixRebuild } = await import("../handlers");
    expect(
      fixRebuild({ alert: "id-x", alert_hash: "h-x", alert_display: "T" }),
    ).toBe("/fix h-x");
  });

  it("falls back to alert id when no hash is available", async () => {
    const { fixRebuild } = await import("../handlers");
    expect(fixRebuild({ alert: "raw-id" })).toBe("/fix raw-id");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 5.8 — /health
// ───────────────────────────────────────────────────────────────────────────

describe("handleHealth — Phase 5.8 suspend integration", () => {
  it("suspends with project slot when no project_id is provided", async () => {
    const { handleHealth } = await import("../handlers");
    const captured: Array<{
      kind: string;
      name: string;
      rebuilt: string;
    }> = [];
    const { ctx } = makeCtx();
    ctx.onSuspended = (state) => {
      captured.push({
        kind: state.needs.kind,
        name: state.needs.name,
        rebuilt: state.rebuild({ project_id: "abc-123" }),
      });
    };
    await handleHealth({ command: "health", args: "" }, ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe("project");
    expect(captured[0]!.name).toBe("project_id");
    expect(captured[0]!.rebuilt).toBe("/health abc-123");
  });

  it("suspends instead of erroring on malformed project_id input (slash/query/hash)", async () => {
    const { handleHealth } = await import("../handlers");
    const captured: Array<{ kind: string }> = [];
    const { ctx } = makeCtx();
    ctx.onSuspended = (state) => {
      captured.push({ kind: state.needs.kind });
    };
    await handleHealth(
      { command: "health", args: "bogus/path?ish#fragment" },
      ctx,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe("project");
  });

  it("legacy path (no onSuspended) surfaces the parse error", async () => {
    const { handleHealth } = await import("../handlers");
    const { ctx, pushed } = makeCtx();
    await handleHealth({ command: "health", args: "" }, ctx);
    const note = pushed.find((m) => m.role === "assistant");
    expect(note?.content).toMatch(/Project id required/i);
  });

  it("happy path (valid project_id) dispatches the IPC unchanged", async () => {
    const { handleHealth } = await import("../handlers");
    const invokeMock = vi.fn().mockResolvedValue(
      okOutcome({
        projectName: "Demo",
        state: "live",
      }),
    );
    const { ctx, pushed } = makeCtx(invokeMock);
    await handleHealth(
      { command: "health", args: "abc-123-def" },
      ctx,
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "cloud.get_project_health",
      { project_id: "abc-123-def" },
      "test-session",
    );
    expect(pushed.some((m) => m.role === "assistant")).toBe(true);
  });
});

describe("healthRebuild", () => {
  it("emits `/health <project_id>`", async () => {
    const { healthRebuild } = await import("../handlers");
    expect(healthRebuild({ project_id: "abc" })).toBe("/health abc");
  });

  it("emits `/health ` (with trailing space) when id is missing", async () => {
    const { healthRebuild } = await import("../handlers");
    // The dispatcher re-parses this and surfaces "Project id required"
    // — which then re-suspends. The picker controls the actual UX;
    // the rebuild's robustness against missing data is just defence.
    expect(healthRebuild({})).toBe("/health ");
  });
});

describe("summarizeProjects() — rich summary", () => {
  it("returns 'no projects' on empty", async () => {
    const { summarizeProjects } = await import("../handlers");
    expect(summarizeProjects([])).toBe("no projects");
  });

  it("ignores non-project entities", async () => {
    const { summarizeProjects } = await import("../handlers");
    const result = summarizeProjects([
      { type: "alert", id: "x", hash: null, title: "t", severity: "info" },
    ]);
    expect(result).toBe("no projects");
  });

  it("inlines id prefix + name", async () => {
    const { summarizeProjects } = await import("../handlers");
    const result = summarizeProjects([
      { type: "project", id: "abc12345-uuid", name: "InariWatch" },
      { type: "project", id: "def67890-uuid", name: "Demo" },
    ]);
    expect(result).toContain("2 projects");
    expect(result).toContain("abc12345");
    expect(result).toContain("InariWatch");
    expect(result).toContain("def67890");
    expect(result).toContain("Demo");
  });

  it("singularises when there's only one project", async () => {
    const { summarizeProjects } = await import("../handlers");
    const result = summarizeProjects([
      { type: "project", id: "x", name: "Solo" },
    ]);
    expect(result).toContain("1 project:");
    expect(result).not.toContain("1 projects");
  });

  it("caps at 5 with a '(+N more)' tail", async () => {
    const { summarizeProjects } = await import("../handlers");
    const many = Array.from({ length: 7 }, (_, i) => ({
      type: "project" as const,
      id: `p-${i}`,
      name: `Project ${i}`,
    }));
    const result = summarizeProjects(many);
    expect(result).toContain("(+2 more)");
  });
});
