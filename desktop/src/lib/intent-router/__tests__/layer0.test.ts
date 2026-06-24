import { describe, expect, it } from "vitest";

import { classifyL0 } from "../layer0-kernel";

const NO_TAIL: never[] = [];

// ── list_alerts ───────────────────────────────────────────────────────

describe("list_alerts", () => {
  it.each([
    "show me my alerts",
    "show alerts",
    "list alerts",
    "¿cuántos errores hay?",
    "cuantas alertas tengo",
    "qué pasó esta noche",
    "qué reventó",
    "what's wrong",
    "what's broken",
    "any new errors?",
    "dame las alertas críticas",
    "alertas recientes",
    "recent alerts",
    "últimas 5 alertas",
    "last errors",
    "muéstrame los fallos",
  ])('"%s" → list_alerts', (msg) => {
    expect(classifyL0(msg, NO_TAIL)?.intent).toBe("list_alerts");
  });
});

// ── status_summary ────────────────────────────────────────────────────

describe("status_summary", () => {
  it.each([
    "cómo está el sistema",
    "cómo va todo",
    "¿todo bien?",
    "todo ok?",
    "system status",
    "service health",
    "system overview",
    "everything ok?",
    "everything working?",
    "qué tal está todo",
    "está todo bien",
  ])('"%s" → status_summary', (msg) => {
    expect(classifyL0(msg, NO_TAIL)?.intent).toBe("status_summary");
  });
});

// ── uptime_monitors ───────────────────────────────────────────────────

describe("uptime_monitors", () => {
  it.each([
    "uptime",
    "uptime status",
    "monitors de uptime",
    "hay algo caído",
    "anything down",
    "están los monitores caídos",
    "cuántos monitores hay",
    "how many monitors",
    "check uptime",
    "response time",
    "latencia",
  ])('"%s" → uptime_monitors', (msg) => {
    expect(classifyL0(msg, NO_TAIL)?.intent).toBe("uptime_monitors");
  });
});

// ── recent_deploys ────────────────────────────────────────────────────

describe("recent_deploys", () => {
  it.each([
    "últimos deploys",
    "recent deployments",
    "last deployments",
    "qué se deployó",
    "qué se subió ayer",
    "what's been deployed",
    "what was merged",
    "recent builds",
    "últimas subidas",
    "últimos releases",
    "vercel deploys",
  ])('"%s" → recent_deploys', (msg) => {
    expect(classifyL0(msg, NO_TAIL)?.intent).toBe("recent_deploys");
  });
});

// ── oncall_status ─────────────────────────────────────────────────────

describe("oncall_status", () => {
  it.each([
    "quién está de guardia",
    "quien está en turno",
    "who is on call",
    "who's on call right now",
    "on-call schedule",
    "on call status",
    "on call ahora",
    "a quién contacto",
    "on call hoy",
  ])('"%s" → oncall_status', (msg) => {
    expect(classifyL0(msg, NO_TAIL)?.intent).toBe("oncall_status");
  });
});

// ── help ──────────────────────────────────────────────────────────────

describe("help", () => {
  it.each([
    "ayuda",
    "help",
    "qué puedes hacer",
    "que sabes hacer",
    "what can you do",
    "what can you help with",
    "cómo te uso",
    "how to use",
    "instrucciones",
  ])('"%s" → help', (msg) => {
    expect(classifyL0(msg, NO_TAIL)?.intent).toBe("help");
  });
});

// ── greeting ──────────────────────────────────────────────────────────

describe("greeting", () => {
  it.each([
    "hola",
    "hey",
    "hi",
    "hello",
    "hola!",
    "buenas",
    "buenas tardes",
    "buenos días",
    "como estas",
    "cómo estás?",
    "que tal",
    "qué onda",
    "what's up",
    "sup",
    "haha",
    "jaja",
    "jajaja",
    "thanks",
    "gracias",
    "ty",
  ])('"%s" → greeting', (msg) => {
    expect(classifyL0(msg, NO_TAIL)?.intent).toBe("greeting");
  });

  // Regression guards: substrings of greeting tokens inside monitoring
  // questions must not steal the intent. `qué pasó` is list_alerts (via
  // a dedicated phrase); `qué puedes hacer` is help; `cómo está el
  // sistema` is status_summary. The greeting phrase regexes are anchored
  // to ^ + bounded so they don't fire on these.
  it.each([
    ["qué pasó esta noche", "list_alerts"],
    ["qué reventó",          "list_alerts"],
    ["qué puedes hacer",     "help"],
    ["que sabes hacer",      "help"],
    ["cómo está el sistema", "status_summary"],
    ["cómo va todo",         "status_summary"],
  ])('"%s" stays on its own intent (%s), not greeting', (msg, expected) => {
    expect(classifyL0(msg, NO_TAIL)?.intent).toBe(expected);
  });
});

// ── open_player ───────────────────────────────────────────────────────

describe("open_player", () => {
  it("detects a bare hash", () => {
    const m = classifyL0("inari:alert:a1b2c3d4e5f6a7b8", NO_TAIL);
    expect(m?.intent).toBe("open_player");
    expect(m?.params.hash).toBe("inari:alert:a1b2c3d4e5f6a7b8");
  });

  it("detects hash embedded in a sentence", () => {
    const m = classifyL0("muéstrame inari:alert:deadbeef12345678 por favor", NO_TAIL);
    expect(m?.intent).toBe("open_player");
    expect(m?.params.hash).toBe("inari:alert:deadbeef12345678");
  });

  it("confidence is 1.0", () => {
    expect(classifyL0("inari:alert:a1b2c3d4e5f6a7b8", NO_TAIL)?.confidence).toBe(1.0);
  });
});

// ── pass-through (should return null) ─────────────────────────────────

describe("pass-through → null", () => {
  it.each([
    "why is auth failing?",
    "por qué hay tantas alertas?",
    "diagnose the database error",
    "what's causing the database timeouts?",
    "explain this regression",
    "fix the memory leak",
    "root cause of the 500 errors",
    "should I rollback this deploy?",
    "analyze the error pattern",
    "what's the correlation between these alerts?",
    "find places where we hash passwords",
  ])('"%s" → null', (msg) => {
    expect(classifyL0(msg, NO_TAIL)).toBeNull();
  });
});

// ── Edge cases ────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("empty string → null", () => {
    expect(classifyL0("", NO_TAIL)).toBeNull();
  });

  it("whitespace only → null", () => {
    expect(classifyL0("   \t\n  ", NO_TAIL)).toBeNull();
  });

  it("confidence ≥ 0.6 for any match at threshold", () => {
    const m = classifyL0("show alerts", NO_TAIL);
    expect(m).not.toBeNull();
    expect(m!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("phrase match produces higher confidence than keyword-only match", () => {
    const phraseMatch = classifyL0("show me my alerts", NO_TAIL);
    const kwMatch     = classifyL0("alerts", NO_TAIL);
    expect(phraseMatch).not.toBeNull();
    expect(kwMatch).not.toBeNull();
    expect(phraseMatch!.confidence).toBeGreaterThanOrEqual(kwMatch!.confidence);
  });

  it("why + alerts negates list_alerts intent", () => {
    expect(classifyL0("why do I have so many alerts?", NO_TAIL)).toBeNull();
  });
});
