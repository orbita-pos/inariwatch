/**
 * Regression corpus for canonical Inari Live slash interactions —
 * Phase 4.7 of the pure-slash refactor (2026-05-15).
 *
 * Two suites:
 *
 *   1. **Deterministic dispatch.** A table of (typed input → expected
 *      backend call) entries that pin the parser + dispatcher wiring.
 *      No LLM involvement. If a future change moves args around,
 *      renames a tool, or breaks an arg parser, the relevant entry
 *      fails loudly with a clear delta. Adding a new slash command
 *      should be paired with at least one entry here.
 *
 *   2. **AI-mocked autocomplete.** Tests the `suggestSlashCommands`
 *      → top-suggestion wiring against fixtured LLM responses (EN +
 *      ES corpus, since user demographic is bilingual). We mock at
 *      the Tauri IPC level (`invoke("suggest_slash_commands", ...)`),
 *      not the model itself — the value-add is asserting that the
 *      wiring still propagates AI suggestions correctly, not that the
 *      LLM produces these specific outputs today. The fixture's role
 *      is "if the LLM returned X, would the autocomplete surface
 *      it?".
 *
 * Off-topic queries (no command matches) and partial / empty
 * responses are also pinned so a regression to the fallback behavior
 * surfaces clearly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudAlert, OncallStatus, UptimeSummary } from "../cloud-ipc";
import type { SlashCloudIpc } from "../slash/handlers";
import { dispatchSlashCommand, type SlashCtx } from "../slash-dispatch";
import { suggestSlashCommands } from "../slash/suggest-ipc";
import type { ChatMessage } from "../store/chat";
import { __resetChatStoreForTests, useChat } from "../store/chat";
import type { InvokeOutcome } from "../tool-invoke-ipc";
import type { WhatsAppResolution } from "../whatsapp-recipient";

// ──────────────────────────────────────────────────────────────────────────
// Shared scaffolding
// ──────────────────────────────────────────────────────────────────────────

function okOutcome(value: unknown = { ok: true }): InvokeOutcome {
  return {
    kind: "output",
    invocation_id: "corpus-inv",
    output: { value, summary: null },
    permission: "auto",
  };
}

/**
 * Build a fully-stubbed `SlashCtx` for the dispatcher. Returns the
 * recorded calls so each test can introspect what the dispatcher
 * decided to invoke.
 */
function makeCtx(opts: {
  cloudAlerts?: CloudAlert[];
  uptime?:      UptimeSummary;
  oncall?:      OncallStatus;
  waResolution?: WhatsAppResolution;
} = {}): {
  ctx: SlashCtx;
  invoke: ReturnType<typeof vi.fn>;
  cloud:  Required<SlashCloudIpc>;
  pushed: ChatMessage[];
} {
  const pushed: ChatMessage[] = [];
  const invoke = vi.fn(async () => okOutcome());

  const cloud: Required<SlashCloudIpc> = {
    getAlerts: vi.fn(async () => opts.cloudAlerts ?? []),
    getUptime: vi.fn(async () =>
      opts.uptime ?? { monitors: [], downCount: 0, avgResponseMs: null },
    ),
    getOncall: vi.fn(async () => opts.oncall ?? { schedules: [] }),
  };

  const ctx: SlashCtx = {
    appendMessage: (m) => {
      pushed.push(m);
    },
    sessionId: "corpus-session",
    invoke,
    cloudIpc: cloud,
    resolveWhatsAppRecipient: async () =>
      opts.waResolution ?? {
        ok: true,
        phone: "+5215512345678",
        match: { entity_id: "e1", display_name: "Demo", phone: "+5215512345678", redacted: "+52 ••••5678" },
      },
  };
  return { ctx, invoke, cloud, pushed };
}

// ──────────────────────────────────────────────────────────────────────────
// Part 1 — Deterministic dispatch corpus
// ──────────────────────────────────────────────────────────────────────────

interface DispatchCorpusEntry {
  label:             string;
  input:             string;
  /**
   * What we expect the dispatcher to do. Exactly one assertion must
   * fire per entry; the rest stay undefined.
   */
  expect:
    | { kind: "tool";       name: string; args: Record<string, unknown> }
    | { kind: "cloudAlerts"; limit: number }
    | { kind: "cloudUptime" }
    | { kind: "cloudOncall" }
    | { kind: "note";       contains: RegExp };
}

const DISPATCH_CORPUS: DispatchCorpusEntry[] = [
  // ── Cloud queries (tool-routed) ──────────────────────────────────────────
  {
    label: "/projects bare → cloud.list_projects with empty args",
    input: "/projects",
    expect: { kind: "tool", name: "cloud.list_projects", args: {} },
  },
  {
    label: "/projects --integration=capture → integration filter forwarded",
    input: "/projects --integration=capture",
    expect: { kind: "tool", name: "cloud.list_projects", args: { integration: "capture" } },
  },
  {
    label: "/projects --integration=vercel (different enum value)",
    input: "/projects --integration=vercel",
    expect: { kind: "tool", name: "cloud.list_projects", args: { integration: "vercel" } },
  },
  {
    label: "/projects --capture (bare shorthand)",
    input: "/projects --capture",
    expect: { kind: "tool", name: "cloud.list_projects", args: { integration: "capture" } },
  },
  {
    label: "/health <uuid> → cloud.get_project_health with project_id",
    input: "/health 0e8a9c1a-deadbeef-1234-5678-90ab",
    expect: {
      kind: "tool",
      name: "cloud.get_project_health",
      args: { project_id: "0e8a9c1a-deadbeef-1234-5678-90ab" },
    },
  },
  {
    label: "/digest → cloud.get_workspace_summary (no args)",
    input: "/digest",
    expect: { kind: "tool", name: "cloud.get_workspace_summary", args: {} },
  },
  {
    label: "/search <text> → search.error_context with error_text",
    input: "/search TypeError: Cannot read properties",
    expect: {
      kind: "tool",
      name: "search.error_context",
      args: { error_text: "TypeError: Cannot read properties" },
    },
  },

  // ── Cloud queries (cloud-IPC routed) ─────────────────────────────────────
  {
    label: "/alerts → cloudIpc.getAlerts(20) by default",
    input: "/alerts",
    expect: { kind: "cloudAlerts", limit: 20 },
  },
  {
    label: "/alerts 50 → cloudIpc.getAlerts(50)",
    input: "/alerts 50",
    expect: { kind: "cloudAlerts", limit: 50 },
  },
  {
    label: "/uptime → cloudIpc.getUptime()",
    input: "/uptime",
    expect: { kind: "cloudUptime" },
  },
  {
    label: "/oncall → cloudIpc.getOncall()",
    input: "/oncall",
    expect: { kind: "cloudOncall" },
  },

  // ── Catalog-routed (slash-catalog entries) ──────────────────────────────
  {
    label: "/url https://… → desktop.open_url with url arg",
    input: "/url https://app.inariwatch.com",
    expect: {
      kind: "tool",
      name: "desktop.open_url",
      args: { url: "https://app.inariwatch.com" },
    },
  },
  {
    label: "/code path:line → desktop.open_in_editor with line",
    input: "/code src/main.rs:42",
    expect: {
      kind: "tool",
      name: "desktop.open_in_editor",
      args: { path: "src/main.rs", line: 42 },
    },
  },
  {
    label: "/code path → desktop.open_in_editor without line",
    input: "/code src/main.rs",
    expect: {
      kind: "tool",
      name: "desktop.open_in_editor",
      args: { path: "src/main.rs" },
    },
  },
  {
    label: "/install <abs path> → setup.install_capture with repo_path",
    input: "/install C:\\Users\\jesus\\projects\\my-app",
    expect: {
      kind: "tool",
      name: "setup.install_capture",
      args: { repo_path: "C:\\Users\\jesus\\projects\\my-app" },
    },
  },
  {
    label: "/install <posix abs> → also accepted",
    input: "/install /home/me/api",
    expect: {
      kind: "tool",
      name: "setup.install_capture",
      args: { repo_path: "/home/me/api" },
    },
  },
  {
    label: "/install <abs path> --project=<id> → both args forwarded",
    input: "/install C:\\src\\app --project=abc123",
    expect: {
      kind: "tool",
      name: "setup.install_capture",
      args: { repo_path: "C:\\src\\app", project_id: "abc123" },
    },
  },

  // ── Comm dispatchers ────────────────────────────────────────────────────
  {
    label: "/telegram <chat> <msg> → comm.send_telegram",
    input: "/telegram @inari_oncall Deploy is degraded",
    expect: {
      kind: "tool",
      name: "comm.send_telegram",
      args: { chat_id: "@inari_oncall", text: "Deploy is degraded" },
    },
  },
  {
    label: "/slack <chan> <msg> → comm.send_slack",
    input: "/slack #alerts Production rolling restart",
    expect: {
      kind: "tool",
      name: "comm.send_slack",
      args: { channel: "#alerts", text: "Production rolling restart" },
    },
  },

  // ── Error paths (assistant note assertion) ──────────────────────────────
  {
    label: "/install (bare) → friendly path-required error",
    input: "/install",
    expect: { kind: "note", contains: /Path required/i },
  },
  {
    label: "/url (bare) → friendly URL-required error",
    input: "/url",
    expect: { kind: "note", contains: /URL required/i },
  },
  {
    label: "/projetcs (typo) → did-you-mean /projects",
    input: "/projetcs",
    expect: { kind: "note", contains: /Did you mean `\/projects`/ },
  },
  {
    label: "/xyzzy (off-the-map) → plain unknown without misleading suggestion",
    input: "/xyzzy",
    expect: { kind: "note", contains: /Unknown command `\/xyzzy`(?!.*Did you mean)/ },
  },
];

describe("slash corpus — deterministic dispatch (Phase 4.7)", () => {
  beforeEach(() => {
    __resetChatStoreForTests();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    __resetChatStoreForTests();
    vi.restoreAllMocks();
  });

  for (const entry of DISPATCH_CORPUS) {
    it(entry.label, async () => {
      const { ctx, invoke, cloud, pushed } = makeCtx({
        // Some /alerts paths require a non-empty result to render —
        // surface a fake cloud alert so the path completes happily.
        cloudAlerts: [
          {
            id: "alert-1",
            title: "Boom",
            severity: "critical",
            createdAt: new Date().toISOString(),
            body: "",
            sourceIntegrations: [],
            projectName: "demo",
            inariHash: "deadbeefdeadbeef",
            isResolved: false,
            aiReasoning: null,
          } as unknown as CloudAlert,
        ],
      });

      // Parse `entry.input` into command + args. The parser already has
      // its own tests; here we just need the structured pair to drive
      // the dispatcher.
      const slashIdx = entry.input.indexOf(" ");
      const command =
        slashIdx === -1
          ? entry.input.slice(1)
          : entry.input.slice(1, slashIdx);
      const argsStr =
        slashIdx === -1 ? "" : entry.input.slice(slashIdx + 1);
      await dispatchSlashCommand({ command, args: argsStr }, ctx);

      switch (entry.expect.kind) {
        case "tool": {
          expect(invoke).toHaveBeenCalledWith(
            entry.expect.name,
            entry.expect.args,
            "corpus-session",
          );
          break;
        }
        case "cloudAlerts": {
          expect(cloud.getAlerts).toHaveBeenCalledWith(entry.expect.limit);
          expect(invoke).not.toHaveBeenCalled();
          break;
        }
        case "cloudUptime": {
          expect(cloud.getUptime).toHaveBeenCalled();
          break;
        }
        case "cloudOncall": {
          expect(cloud.getOncall).toHaveBeenCalled();
          break;
        }
        case "note": {
          // The user echo is at index 0; the assistant note at index 1.
          const note = pushed.find((m) => m.role === "assistant");
          expect(note?.content ?? "").toMatch(entry.expect.contains);
          break;
        }
      }
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Part 2 — AI-mocked autocomplete wiring
// ──────────────────────────────────────────────────────────────────────────

interface AICorpusEntry {
  /** Natural-language query the user types in the input bar. */
  query:           string;
  /**
   * Fixture LLM response — the suggestions array the
   * `/api/ai/suggest-slash` endpoint would return for this query.
   * `null` means "the LLM produced no useful suggestions" (off-topic
   * or unsupported), which the autocomplete should surface as the
   * "No command matches" hint.
   */
  fixtureResponse: Array<{
    command:    string;
    rationale:  string;
    confidence: number;
  }> | null;
  /**
   * Expected top suggestion command, or `null` for the off-topic
   * branch. The corpus only asserts the top entry — ordering of the
   * tail is the LLM's prerogative.
   */
  expectTopCommand: string | null;
}

const AI_CORPUS_ES: AICorpusEntry[] = [
  {
    query: "qué proyectos tienen capture",
    fixtureResponse: [
      {
        command: "/projects --integration=capture",
        rationale: "Filtra proyectos por integración 'capture'",
        confidence: 0.93,
      },
    ],
    expectTopCommand: "/projects --integration=capture",
  },
  {
    query: "instala capture en D:/web",
    fixtureResponse: [
      {
        command: "/install D:/web",
        rationale: "Instala @inariwatch/capture en D:/web",
        confidence: 0.95,
      },
    ],
    expectTopCommand: "/install D:/web",
  },
  {
    query: "alertas recientes",
    fixtureResponse: [
      {
        command: "/alerts",
        rationale: "Lista alertas recientes del workspace",
        confidence: 0.88,
      },
    ],
    expectTopCommand: "/alerts",
  },
  {
    query: "muéstrame el digest",
    fixtureResponse: [
      {
        command: "/digest",
        rationale: "Resumen agregado del workspace",
        confidence: 0.91,
      },
    ],
    expectTopCommand: "/digest",
  },
  {
    query: "no entiendo MTTR",
    // Off-topic — the LLM returns no suggestions.
    fixtureResponse: null,
    expectTopCommand: null,
  },
  {
    query: "explícame el universo",
    fixtureResponse: null,
    expectTopCommand: null,
  },
];

const AI_CORPUS_EN: AICorpusEntry[] = [
  {
    query: "show me recent alerts",
    fixtureResponse: [
      {
        command: "/alerts",
        rationale: "List recent workspace alerts",
        confidence: 0.9,
      },
    ],
    expectTopCommand: "/alerts",
  },
  {
    query: "open my projects with capture installed",
    fixtureResponse: [
      {
        command: "/projects --integration=capture",
        rationale: "Filter projects by the capture integration",
        confidence: 0.92,
      },
    ],
    expectTopCommand: "/projects --integration=capture",
  },
  {
    query: "who is on call",
    fixtureResponse: [
      {
        command: "/oncall",
        rationale: "Current on-call assignments",
        confidence: 0.89,
      },
    ],
    expectTopCommand: "/oncall",
  },
  {
    query: "are my sites up",
    fixtureResponse: [
      {
        command: "/uptime",
        rationale: "Uptime monitors across the workspace",
        confidence: 0.87,
      },
    ],
    expectTopCommand: "/uptime",
  },
  {
    query: "show me a list of all integrations available",
    // Off-topic — there's no command for this.
    fixtureResponse: null,
    expectTopCommand: null,
  },
  {
    query: "what is the weather today",
    fixtureResponse: null,
    expectTopCommand: null,
  },
];

/**
 * Set up the Tauri-API mock so `suggestSlashCommands(query)` returns
 * the queued fixture response. The IPC name routed is
 * `suggest_slash_commands` per the IPC contract.
 */
const queuedResponses = new Map<string, AICorpusEntry["fixtureResponse"]>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { query: string }) => {
    if (cmd !== "suggest_slash_commands") return [];
    const fixture = queuedResponses.get(args.query);
    return fixture === null || fixture === undefined ? [] : fixture;
  }),
}));

function runAICorpus(label: string, corpus: AICorpusEntry[]): void {
  describe(label, () => {
    beforeEach(() => {
      queuedResponses.clear();
    });

    for (const entry of corpus) {
      it(`${entry.query} → ${entry.expectTopCommand ?? "(no match)"}`, async () => {
        queuedResponses.set(entry.query, entry.fixtureResponse);
        const result = await suggestSlashCommands(entry.query);
        if (entry.expectTopCommand === null) {
          expect(result).toEqual([]);
        } else {
          expect(result.length).toBeGreaterThan(0);
          expect(result[0]?.command).toBe(entry.expectTopCommand);
        }
      });
    }
  });
}

describe("slash corpus — AI-mocked autocomplete (Phase 4.7)", () => {
  runAICorpus("Spanish corpus", AI_CORPUS_ES);
  runAICorpus("English corpus", AI_CORPUS_EN);

  it("treats missing fixtures the same as off-topic (defensive)", async () => {
    queuedResponses.clear();
    const result = await suggestSlashCommands("never queued");
    expect(result).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Part 3 — Phase 5 SuspendedCommand + scoped memory corpus
// ──────────────────────────────────────────────────────────────────────────
//
// Cases below cover the new interactive flows: missing-arg → correct
// slot type, picker resume → merge → re-dispatch, scoped memory
// promoting recent entities, bilingual reference resolution, and
// placement+cacheability invariants for the autocomplete prompt.
// Each case is one assertion-per-test so a regression names exactly
// which Phase 5 contract broke.

import { ScopedMemory } from "../slash/scoped-memory";
import {
  mergeSlotValue,
  type PartialCommand,
  type SlotSpec,
  type SuspendedState,
} from "../slash/suspended-command";

interface SuspendCorpusEntry {
  label: string;
  command: string;
  args: string;
  expectKind: "contact" | "project" | "alert" | "path" | "text";
  expectName: string;
  /** Snippet from the rebuild output that must appear after the resume. */
  expectRebuildContains?: string;
  resumeWith?: Record<string, unknown>;
}

const SUSPEND_CORPUS: SuspendCorpusEntry[] = [
  {
    label: "/whatsapp (bare) → contact slot",
    command: "whatsapp",
    args: "",
    expectKind: "contact",
    expectName: "recipient",
    resumeWith: { recipient: "+5215512345678", message: "hi" },
    expectRebuildContains: "/whatsapp +5215512345678 hi",
  },
  {
    label: "/install (bare) → path slot",
    command: "install",
    args: "",
    expectKind: "path",
    expectName: "path",
    resumeWith: { path: "D:\\web" },
    expectRebuildContains: "/install D:\\web",
  },
  {
    label: "/install C:web (non-absolute) → path slot",
    command: "install",
    args: "C:web",
    expectKind: "path",
    expectName: "path",
    resumeWith: { path: "C:\\web" },
    expectRebuildContains: "/install C:\\web",
  },
  {
    label: "/fix (bare) → alert slot",
    command: "fix",
    args: "",
    expectKind: "alert",
    expectName: "hash",
    resumeWith: { hash: "1a2b3c4d" },
    expectRebuildContains: "/fix 1a2b3c4d",
  },
  {
    label: "/fix bogus-hash → alert slot",
    command: "fix",
    args: "not-hex",
    expectKind: "alert",
    expectName: "hash",
    resumeWith: { hash: "1a2b3c4d5e6f" },
    expectRebuildContains: "/fix 1a2b3c4d5e6f",
  },
  {
    label: "/health (bare) → project slot",
    command: "health",
    args: "",
    expectKind: "project",
    expectName: "project_id",
    resumeWith: { project_id: "abc-123" },
    expectRebuildContains: "/health abc-123",
  },
];

describe("slash corpus — Phase 5 SuspendedCommand flows", () => {
  beforeEach(() => __resetChatStoreForTests());

  for (const entry of SUSPEND_CORPUS) {
    it(entry.label, async () => {
      const captured: SuspendedState[] = [];
      const { ctx } = makeCtx();
      ctx.onSuspended = (state) => captured.push(state);
      await dispatchSlashCommand(
        { command: entry.command, args: entry.args },
        ctx,
      );
      expect(captured).toHaveLength(1);
      expect(captured[0]!.needs.kind).toBe(entry.expectKind);
      expect(captured[0]!.needs.name).toBe(entry.expectName);
      if (entry.resumeWith && entry.expectRebuildContains) {
        const rebuilt = captured[0]!.rebuild(entry.resumeWith);
        expect(rebuilt).toContain(entry.expectRebuildContains);
      }
    });
  }

  it("legacy callers (no onSuspended) still get the parse-error notes", async () => {
    // Three commands × distinct error vocabularies — locks the
    // pre-Phase-5 behavior so a future "always-suspend" refactor
    // doesn't break test harnesses that don't render a UI.
    const cases: Array<{ cmd: string; args: string; expect: RegExp }> = [
      { cmd: "whatsapp", args: "", expect: /Recipient \+ message required/i },
      { cmd: "install",  args: "", expect: /Path required/i },
      { cmd: "fix",      args: "", expect: /Inari hash required/i },
      { cmd: "health",   args: "", expect: /Project id required/i },
    ];
    for (const c of cases) {
      const { ctx, pushed } = makeCtx();
      await dispatchSlashCommand({ command: c.cmd, args: c.args }, ctx);
      const note = pushed.find((m) => m.role === "assistant");
      expect(note?.content ?? "").toMatch(c.expect);
    }
  });

  it("mergeSlotValue + rebuild produce a parseable resume input", async () => {
    // Drives the full happy path: suspend → pick → merge → rebuild
    // → re-dispatch. The terminal `invoke` must see the right tool
    // call so the suspend/resume cycle is bit-equivalent to the
    // user typing the canonical form upfront.
    const captured: SuspendedState[] = [];
    const { ctx, invoke } = makeCtx();
    ctx.onSuspended = (state) => captured.push(state);
    await dispatchSlashCommand({ command: "install", args: "" }, ctx);
    expect(captured).toHaveLength(1);
    const partial: PartialCommand = captured[0]!.partial;
    const spec: SlotSpec = captured[0]!.needs;
    const merged = mergeSlotValue(partial, spec.name, {
      kind: "path",
      value: "/home/me/api",
    });
    const rebuilt = captured[0]!.rebuild(merged);
    expect(rebuilt).toBe("/install /home/me/api");
    // Re-dispatch — the second dispatch should reach the catalog
    // happy path and invoke setup.install_capture verbatim.
    await dispatchSlashCommand(
      { command: "install", args: "/home/me/api" },
      ctx,
    );
    expect(invoke).toHaveBeenCalledWith(
      "setup.install_capture",
      { repo_path: "/home/me/api" },
      "corpus-session",
    );
  });

  // ── Scoped-memory reference resolution ──────────────────────────────────

  it("scoped memory resolves 'esa alerta' to the most recent alert id", () => {
    const memory = new ScopedMemory();
    memory.push({
      commandName: "alerts",
      args: { limit: 20 },
      summary: "1 critical: inari:alert:deadbeef (TypeError 12:00)",
      entities: [
        {
          type: "alert",
          id: "a-deadbeef",
          hash: "deadbeefdeadbeef",
          title: "TypeError",
          severity: "critical",
        },
      ],
    });
    const resolved = memory.resolveReference("fixea esa alerta");
    if (resolved?.type !== "alert") throw new Error("expected alert");
    expect(resolved.id).toBe("a-deadbeef");
    expect(resolved.hash).toBe("deadbeefdeadbeef");
  });

  it("scoped memory resolves 'el último proyecto' to the newest project", () => {
    const memory = new ScopedMemory();
    memory.push({
      commandName: "projects",
      args: {},
      summary: "2 projects",
      entities: [
        { type: "project", id: "p-old", name: "Old" },
        { type: "project", id: "p-new", name: "New" },
      ],
    });
    const resolved = memory.resolveReference("/health el último proyecto");
    if (resolved?.type !== "project") throw new Error("expected project");
    expect(resolved.id).toBe("p-new");
  });

  it("scoped memory's 'the first' (English) resolves to entities[0]", () => {
    const memory = new ScopedMemory();
    memory.push({
      commandName: "alerts",
      args: {},
      summary: "",
      entities: [
        { type: "alert", id: "first", hash: null, title: "f", severity: "info" },
        { type: "alert", id: "second", hash: null, title: "s", severity: "info" },
      ],
    });
    const resolved = memory.resolveReference("ack the first");
    if (resolved?.type !== "alert") throw new Error("expected alert");
    expect(resolved.id).toBe("first");
  });

  // ── Autocomplete prompt placement + cacheability (mini-diff 3) ──────────

  // ── Phase 5.6 completion — project-link bridge ────────────────────────

  it("/install <abs path> with no linked project → suspends with project_link", async () => {
    const captured: SuspendedState[] = [];
    const { ctx } = makeCtx();
    ctx.onSuspended = (state) => captured.push(state);
    ctx.installDeps = {
      listProjects: async () => ({ projects: [{ id: "p-other", name: "Other" }] }),
      getLocalPath: async () => "D:\\unrelated",
    };
    await dispatchSlashCommand(
      { command: "install", args: "D:\\web" },
      ctx,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.needs.kind).toBe("project_link");
    expect(captured[0]!.needs.optionsHint?.path).toBe("D:\\web");
  });

  it("/install <abs path> with matching linked project → dispatches with auto-injected project_id", async () => {
    const captured: SuspendedState[] = [];
    const invokeMock = vi.fn(async () => okOutcome());
    const { ctx } = makeCtx();
    ctx.invoke = invokeMock;
    ctx.onSuspended = (state) => captured.push(state);
    ctx.installDeps = {
      listProjects: async () => ({ projects: [{ id: "p-web", name: "Web" }] }),
      getLocalPath: async (id) => (id === "p-web" ? "D:\\web" : null),
    };
    await dispatchSlashCommand(
      { command: "install", args: "D:\\web" },
      ctx,
    );
    expect(captured).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith(
      "setup.install_capture",
      { repo_path: "D:\\web", project_id: "p-web" },
      "corpus-session",
    );
  });

  it("resume from project_link slot serialises with --project=<id>", async () => {
    const captured: SuspendedState[] = [];
    const { ctx } = makeCtx();
    ctx.onSuspended = (state) => captured.push(state);
    ctx.installDeps = {
      listProjects: async () => ({ projects: [] }),
      getLocalPath: async () => null,
    };
    await dispatchSlashCommand(
      { command: "install", args: "D:\\web" },
      ctx,
    );
    expect(captured).toHaveLength(1);
    const rebuilt = captured[0]!.rebuild({
      ...captured[0]!.partial.collectedArgs,
      project_id: "wizard-minted",
    });
    expect(rebuilt).toContain("D:\\web");
    expect(rebuilt).toContain("--project=wizard-minted");
  });

  it("autocomplete IPC forwards memoryContext to the wire body", async () => {
    queuedResponses.clear();
    // Tauri IPC mock — capture the args object so we can introspect
    // memoryContext. The module-level mock returns `[]` by default;
    // we re-import to get the vi-tracked function and inspect calls.
    const tauri = await import("@tauri-apps/api/core");
    const invokeFn = tauri.invoke as unknown as {
      mock: { calls: Array<[string, { memoryContext?: unknown }]> };
    };
    const before = invokeFn.mock.calls.length;
    await suggestSlashCommands("fixea la del payment", {
      memoryContext: "Recent context: alert_abc",
    });
    const after = invokeFn.mock.calls.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]![1].memoryContext).toBe("Recent context: alert_abc");
  });
});
