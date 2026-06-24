/**
 * Phase 5.3 — scoped memory ring buffer + bilingual reference resolver.
 *
 * Covers:
 *   1. Buffer mechanics — push, capacity eviction, reset, recent(n).
 *   2. Tokenizer + per-token classifiers (TYPE_TOKENS, ORDINAL_TOKENS,
 *      DEMONSTRATIVES).
 *   3. resolveReference — type + ordinal interplay, fallback to last
 *      entry, bilingual coverage (es + en).
 *   4. Prompt-context formatter — empty-buffer no-op, entity cap,
 *      relative-time stamp.
 */
import { describe, expect, it } from "vitest";

import {
  ScopedMemory,
  atOrdinal,
  collectByType,
  describeEntity,
  findOrdinal,
  findTypeHint,
  formatAge,
  hasDemonstrative,
  tokenize,
  type MemoryEntry,
  type ResolvedEntity,
} from "../slash/scoped-memory";

// ── Fixtures ───────────────────────────────────────────────────────────────

const alert = (
  over: Partial<Extract<ResolvedEntity, { type: "alert" }>> = {},
): ResolvedEntity => ({
  type: "alert",
  id: "a-1",
  hash: "1a2b3c4d5e6f7890",
  title: "TypeError in /api/foo",
  severity: "critical",
  ...over,
});

const project = (
  over: Partial<Extract<ResolvedEntity, { type: "project" }>> = {},
): ResolvedEntity => ({
  type: "project",
  id: "p-1",
  name: "InariWatch",
  ...over,
});

const contact = (
  over: Partial<Extract<ResolvedEntity, { type: "contact" }>> = {},
): ResolvedEntity => ({
  type: "contact",
  jid: "+5215512345678",
  name: "Jose",
  ...over,
});

const path = (value = "D:\\web"): ResolvedEntity => ({
  type: "path",
  value,
});

function fakeClock(start = 1_000_000) {
  let t = start;
  return () => {
    t += 1; // strict monotonic so iteration order matches push order
    return t;
  };
}

// ── Buffer mechanics ───────────────────────────────────────────────────────

describe("ScopedMemory buffer mechanics", () => {
  it("starts empty", () => {
    const m = new ScopedMemory();
    expect(m.size()).toBe(0);
    expect(m.recent()).toEqual([]);
  });

  it("push() appends entries, recent() returns newest last", () => {
    const m = new ScopedMemory({ now: fakeClock() });
    m.push({
      commandName: "alerts",
      args: { limit: 20 },
      summary: "5 critical",
      entities: [alert()],
    });
    m.push({
      commandName: "projects",
      args: {},
      summary: "3 projects",
      entities: [project()],
    });
    expect(m.size()).toBe(2);
    const recent = m.recent();
    expect(recent[0]!.commandName).toBe("alerts");
    expect(recent[1]!.commandName).toBe("projects");
  });

  it("evicts the oldest entry beyond capacity (default 3)", () => {
    const m = new ScopedMemory({ now: fakeClock() });
    for (const n of ["a", "b", "c", "d"]) {
      m.push({
        commandName: n,
        args: {},
        summary: n,
        entities: [],
      });
    }
    expect(m.size()).toBe(3);
    expect(m.recent().map((e) => e.commandName)).toEqual(["b", "c", "d"]);
  });

  it("respects a custom capacity", () => {
    const m = new ScopedMemory({ capacity: 1, now: fakeClock() });
    m.push({ commandName: "x", args: {}, summary: "x", entities: [] });
    m.push({ commandName: "y", args: {}, summary: "y", entities: [] });
    expect(m.size()).toBe(1);
    expect(m.recent()[0]!.commandName).toBe("y");
  });

  it("reset() empties the buffer", () => {
    const m = new ScopedMemory({ now: fakeClock() });
    m.push({ commandName: "x", args: {}, summary: "x", entities: [] });
    expect(m.size()).toBe(1);
    m.reset();
    expect(m.size()).toBe(0);
    expect(m.recent()).toEqual([]);
  });

  it("auto-stamps timestamp from the configured clock", () => {
    let next = 1_000;
    const m = new ScopedMemory({ now: () => ++next });
    m.push({ commandName: "x", args: {}, summary: "x", entities: [] });
    expect(m.recent()[0]!.timestamp).toBe(1_001);
  });
});

// ── Tokenizer ──────────────────────────────────────────────────────────────

describe("tokenize()", () => {
  it("splits on whitespace + punctuation, lowercases", () => {
    expect(tokenize("Fix esa alerta!")).toEqual(["fix", "esa", "alerta"]);
    expect(tokenize("¿Esa, alerta?")).toEqual(["esa", "alerta"]);
  });

  it("returns empty array for empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("    ")).toEqual([]);
  });
});

describe("findTypeHint()", () => {
  it("recognises Spanish + English type tokens", () => {
    expect(findTypeHint(["alerta"])).toBe("alert");
    expect(findTypeHint(["alert"])).toBe("alert");
    expect(findTypeHint(["proyecto"])).toBe("project");
    expect(findTypeHint(["repo"])).toBe("project");
    expect(findTypeHint(["contact"])).toBe("contact");
    expect(findTypeHint(["carpeta"])).toBe("path");
    expect(findTypeHint(["folder"])).toBe("path");
  });

  it("matches the first hit when multiple tokens map", () => {
    expect(findTypeHint(["alerta", "proyecto"])).toBe("alert");
  });

  it("returns null when no token matches", () => {
    expect(findTypeHint(["xyz", "esa"])).toBeNull();
  });
});

describe("findOrdinal()", () => {
  it("recognises positional ordinals (es + en)", () => {
    expect(findOrdinal(["primero"])).toBe(0);
    expect(findOrdinal(["first"])).toBe(0);
    expect(findOrdinal(["segundo"])).toBe(1);
    expect(findOrdinal(["second"])).toBe(1);
    expect(findOrdinal(["tercera"])).toBe(2);
    expect(findOrdinal(["third"])).toBe(2);
  });

  it("recognises 'last' / 'último' as -1", () => {
    expect(findOrdinal(["último"])).toBe(-1);
    expect(findOrdinal(["ultimo"])).toBe(-1);
    expect(findOrdinal(["last"])).toBe(-1);
  });

  it("returns null when no ordinal token is present", () => {
    expect(findOrdinal(["esa", "alerta"])).toBeNull();
  });
});

describe("hasDemonstrative()", () => {
  it("matches Spanish demonstratives", () => {
    expect(hasDemonstrative(["esa"])).toBe(true);
    expect(hasDemonstrative(["aquel"])).toBe(true);
    expect(hasDemonstrative(["la"])).toBe(true);
  });

  it("matches English demonstratives", () => {
    expect(hasDemonstrative(["that"])).toBe(true);
    expect(hasDemonstrative(["the"])).toBe(true);
  });

  it("false on non-demonstratives", () => {
    expect(hasDemonstrative(["fixea", "alerta"])).toBe(false);
  });
});

// ── Resolver ───────────────────────────────────────────────────────────────

describe("ScopedMemory.resolveReference()", () => {
  function freshWithRecentAlerts(): ScopedMemory {
    const m = new ScopedMemory({ now: fakeClock() });
    m.push({
      commandName: "alerts",
      args: { limit: 20 },
      summary: "3 alerts",
      entities: [
        alert({ id: "a-1", title: "First", severity: "critical" }),
        alert({ id: "a-2", title: "Second", severity: "warning" }),
        alert({ id: "a-3", title: "Third", severity: "info" }),
      ],
    });
    return m;
  }

  it("resolves 'esa alerta' → most recent alert", () => {
    const m = freshWithRecentAlerts();
    const r = m.resolveReference("fixea esa alerta");
    expect(r?.type).toBe("alert");
    if (r?.type !== "alert") return;
    expect(r.id).toBe("a-3");
  });

  it("resolves 'that alert' (English) → most recent alert", () => {
    const m = freshWithRecentAlerts();
    const r = m.resolveReference("fix that alert");
    expect(r?.type).toBe("alert");
  });

  it("resolves 'el primero' → first entity of the most recent entry", () => {
    const m = freshWithRecentAlerts();
    const r = m.resolveReference("ack el primero");
    expect(r?.type).toBe("alert");
    if (r?.type !== "alert") return;
    expect(r.id).toBe("a-1");
  });

  it("resolves 'the last' → last entity of the most recent entry", () => {
    const m = freshWithRecentAlerts();
    const r = m.resolveReference("ack the last");
    if (r?.type !== "alert") throw new Error("expected alert");
    expect(r.id).toBe("a-3");
  });

  it("resolves 'el último proyecto' → most recent project across buffer", () => {
    const m = new ScopedMemory({ now: fakeClock() });
    m.push({
      commandName: "projects",
      args: {},
      summary: "2 projects",
      entities: [
        project({ id: "p-1", name: "Old" }),
        project({ id: "p-2", name: "New" }),
      ],
    });
    m.push({
      commandName: "alerts",
      args: {},
      summary: "0 alerts",
      entities: [],
    });
    const r = m.resolveReference("health el último proyecto");
    expect(r?.type).toBe("project");
    if (r?.type !== "project") return;
    expect(r.id).toBe("p-2");
  });

  it("returns null when the buffer is empty", () => {
    const m = new ScopedMemory();
    expect(m.resolveReference("esa alerta")).toBeNull();
  });

  it("returns null when no demonstrative / ordinal / type token is present", () => {
    const m = freshWithRecentAlerts();
    expect(m.resolveReference("hola que tal")).toBeNull();
  });

  it("returns null when the typed entity has no rows", () => {
    const m = freshWithRecentAlerts();
    // Buffer has alerts only — asking for "ese proyecto" returns null.
    expect(m.resolveReference("ese proyecto")).toBeNull();
  });

  it("bare demonstrative defaults to first entity of last entry", () => {
    const m = freshWithRecentAlerts();
    const r = m.resolveReference("fixea esa");
    if (r?.type !== "alert") throw new Error("expected alert");
    expect(r.id).toBe("a-1");
  });

  it("type + ordinal combines correctly", () => {
    const m = freshWithRecentAlerts();
    const r = m.resolveReference("la segunda alerta");
    if (r?.type !== "alert") throw new Error("expected alert");
    expect(r.id).toBe("a-2");
  });

  it("returns null on out-of-range ordinal", () => {
    const m = freshWithRecentAlerts();
    // Only 3 alerts; "la cuarta" doesn't exist.
    expect(m.resolveReference("la octava alerta")).toBeNull();
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

describe("collectByType()", () => {
  it("walks the buffer and concatenates entities of the given type", () => {
    const buffer: MemoryEntry[] = [
      {
        commandName: "alerts",
        args: {},
        summary: "",
        entities: [alert({ id: "a-1" }), project({ id: "p-1" })],
        timestamp: 1,
      },
      {
        commandName: "alerts",
        args: {},
        summary: "",
        entities: [alert({ id: "a-2" })],
        timestamp: 2,
      },
    ];
    const alerts = collectByType(buffer, "alert");
    expect(alerts.map((a) => (a as { id: string }).id)).toEqual(["a-1", "a-2"]);
  });

  it("returns empty when no entities match", () => {
    const buffer: MemoryEntry[] = [
      {
        commandName: "alerts",
        args: {},
        summary: "",
        entities: [alert()],
        timestamp: 1,
      },
    ];
    expect(collectByType(buffer, "project")).toEqual([]);
  });
});

describe("atOrdinal()", () => {
  const list: ResolvedEntity[] = [
    alert({ id: "a" }),
    alert({ id: "b" }),
    alert({ id: "c" }),
  ];

  it("positive ordinals index from the start", () => {
    expect((atOrdinal(list, 0) as { id: string }).id).toBe("a");
    expect((atOrdinal(list, 1) as { id: string }).id).toBe("b");
    expect((atOrdinal(list, 2) as { id: string }).id).toBe("c");
  });

  it("-1 returns the last element", () => {
    expect((atOrdinal(list, -1) as { id: string }).id).toBe("c");
  });

  it("returns null on out-of-range positive index", () => {
    expect(atOrdinal(list, 5)).toBeNull();
  });

  it("returns null on out-of-range negative index", () => {
    expect(atOrdinal(list, -5)).toBeNull();
  });

  it("returns null on empty list", () => {
    expect(atOrdinal([], 0)).toBeNull();
  });
});

describe("describeEntity()", () => {
  it("formats alert with severity + truncated title + hash prefix", () => {
    const s = describeEntity(alert({ title: "Big bad TypeError thrown" }));
    expect(s).toContain("alert");
    expect(s).toContain("severity=critical");
    expect(s).toContain("hash=1a2b3c4d");
  });

  it("formats project with optional path", () => {
    const s = describeEntity(project({ localPath: "D:\\web" }));
    expect(s).toContain("project");
    expect(s).toContain("path=D:\\web");
  });

  it("formats contact + path consistently", () => {
    expect(describeEntity(contact())).toContain('jid=+5215512345678');
    expect(describeEntity(path("/tmp/foo"))).toContain("/tmp/foo");
  });
});

describe("formatAge()", () => {
  it("returns 'just now' for very fresh entries", () => {
    expect(formatAge(0)).toBe("just now");
    expect(formatAge(10_000)).toBe("just now");
  });

  it("returns minutes for sub-hour deltas", () => {
    expect(formatAge(120_000)).toBe("2m ago");
    expect(formatAge(59 * 60_000)).toBe("59m ago");
  });

  it("returns hours for ≥1h deltas", () => {
    expect(formatAge(60 * 60_000)).toBe("1h ago");
    expect(formatAge(3 * 60 * 60_000)).toBe("3h ago");
  });
});

// ── Autocomplete prompt context ─────────────────────────────────────────────

describe("ScopedMemory.toAutocompletePromptContext()", () => {
  it("returns empty string when the buffer is empty", () => {
    const m = new ScopedMemory();
    expect(m.toAutocompletePromptContext()).toBe("");
  });

  it("renders the buffer with a 'Recent context' header and one block per entry", () => {
    let t = 1_000_000;
    const m = new ScopedMemory({ now: () => ++t });
    m.push({
      commandName: "alerts",
      args: { limit: 20 },
      summary: "3 alerts in last 24h",
      entities: [alert({ id: "a-1" }), alert({ id: "a-2" })],
    });
    m.push({
      commandName: "projects",
      args: {},
      summary: "2 projects",
      entities: [project({ id: "p-1" })],
    });
    const text = m.toAutocompletePromptContext();
    expect(text).toContain("Recent context");
    expect(text).toContain("/alerts");
    expect(text).toContain("3 alerts in last 24h");
    expect(text).toContain("/projects");
    expect(text).toContain("alert id=a-1");
    expect(text).toContain("project id=p-1");
  });

  it("caps the per-entry entity expansion at 8 + summary line", () => {
    let t = 1_000;
    const m = new ScopedMemory({ now: () => ++t });
    const alerts: ResolvedEntity[] = [];
    for (let i = 0; i < 12; i++) {
      alerts.push(alert({ id: `a-${i}` }));
    }
    m.push({
      commandName: "alerts",
      args: {},
      summary: "12 alerts",
      entities: alerts,
    });
    const text = m.toAutocompletePromptContext();
    const expanded = (text.match(/^  •/gm) ?? []).length;
    expect(expanded).toBe(9); // 8 alerts + "(+4 more)" line
    expect(text).toContain("(+4 more)");
  });
});
