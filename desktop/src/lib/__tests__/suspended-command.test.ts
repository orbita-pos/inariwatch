/**
 * Inari Live Phase 5.1 — protocol unit tests.
 *
 * Covers the typed surface in `lib/slash/suspended-command.ts`:
 * helpers (`suspend`, `mergeSlotValue`, `describeCollected`), slot
 * value shape narrowing, and the no-op suspended handler. Dispatcher
 * integration (the `onSuspended` ctx field + `resumeSlashCommand`)
 * gets its own coverage in slash-dispatch.test.ts as part of the
 * existing dispatcher test surface.
 */
import { describe, expect, it, vi } from "vitest";

import {
  NOOP_SUSPENDED,
  describeCollected,
  makeSuspendedEchoForTest,
  mergeSlotValue,
  suspend,
  type CommandResult,
  type PartialCommand,
  type SlotSpec,
  type SlotValue,
} from "../slash/suspended-command";

// ── `suspend` constructor ──────────────────────────────────────────────────

describe("suspend()", () => {
  it("returns a {kind: 'suspended'} discriminant with the spec + partial", () => {
    const spec: SlotSpec = {
      kind: "contact",
      name: "recipient",
      prompt: "who?",
    };
    const result = suspend({ command: "whatsapp", needs: spec });
    expect(result.kind).toBe("suspended");
    if (result.kind !== "suspended") return; // type guard
    expect(result.needs).toBe(spec);
    expect(result.partial).toEqual({
      command: "whatsapp",
      collectedArgs: {},
      rawArgs: "",
    });
  });

  it("preserves rawArgs + collectedArgs when provided", () => {
    const spec: SlotSpec = {
      kind: "text",
      name: "message",
      prompt: "message body",
    };
    const result = suspend({
      command: "whatsapp",
      needs: spec,
      rawArgs: "Jose",
      collectedArgs: {
        recipient: "+5215512345678",
        recipient_display: "Jose",
      },
    });
    if (result.kind !== "suspended") throw new Error("expected suspended");
    expect(result.partial.rawArgs).toBe("Jose");
    expect(result.partial.collectedArgs.recipient).toBe("+5215512345678");
    expect(result.partial.collectedArgs.recipient_display).toBe("Jose");
  });

  it("attaches a default positional rebuilder when none is provided", () => {
    const result = suspend({
      command: "install",
      needs: { kind: "path", name: "path", prompt: "which folder?" },
    });
    if (result.kind !== "suspended") throw new Error("expected suspended");
    const rebuilt = result.rebuild({ path: "D:\\web" });
    expect(rebuilt).toBe("/install D:\\web");
  });

  it("default rebuilder skips *_display / *_hash / *_path companion keys", () => {
    const result = suspend({
      command: "fix",
      needs: { kind: "alert", name: "alert", prompt: "which alert?" },
    });
    if (result.kind !== "suspended") throw new Error("expected suspended");
    const rebuilt = result.rebuild({
      alert: "1a2b3c4d",
      alert_hash: "1a2b3c4d",
      alert_display: "Big bad TypeError",
    });
    // Only the canonical `alert` key — no extra display/hash tokens.
    expect(rebuilt).toBe("/fix 1a2b3c4d");
  });

  it("uses the supplied rebuild verbatim when provided", () => {
    const result = suspend({
      command: "whatsapp",
      needs: { kind: "text", name: "message", prompt: "message body" },
      rebuild: (args) =>
        `/whatsapp ${args.recipient} ${args.message ?? ""}`.trim(),
    });
    if (result.kind !== "suspended") throw new Error("expected suspended");
    expect(
      result.rebuild({ recipient: "+1", message: "hello" }),
    ).toBe("/whatsapp +1 hello");
  });
});

// ── `mergeSlotValue` per-kind expansion ────────────────────────────────────

describe("mergeSlotValue()", () => {
  const partial: PartialCommand = {
    command: "whatsapp",
    collectedArgs: {},
    rawArgs: "",
  };

  it("contact: maps jid → slot, name → slot_display", () => {
    const merged = mergeSlotValue(partial, "recipient", {
      kind: "contact",
      jid: "+5215512345678",
      name: "Jose",
    });
    expect(merged).toEqual({
      recipient: "+5215512345678",
      recipient_display: "Jose",
    });
  });

  it("project: maps id → slot, name → slot_display, path → slot_path (when present)", () => {
    const merged = mergeSlotValue(partial, "project", {
      kind: "project",
      id: "abc-123",
      name: "InariWatch",
      path: "C:\\Users\\jesus\\repo",
    });
    expect(merged.project).toBe("abc-123");
    expect(merged.project_display).toBe("InariWatch");
    expect(merged.project_path).toBe("C:\\Users\\jesus\\repo");
  });

  it("project: omits slot_path when path is undefined", () => {
    const merged = mergeSlotValue(partial, "project", {
      kind: "project",
      id: "abc-123",
      name: "InariWatch",
    });
    expect("project_path" in merged).toBe(false);
  });

  it("alert: maps id → slot, hash → slot_hash, title → slot_display", () => {
    const merged = mergeSlotValue(partial, "alert", {
      kind: "alert",
      id: "a1",
      hash: "1a2b3c4d",
      title: "TypeError in /api/foo",
    });
    expect(merged).toEqual({
      alert: "a1",
      alert_hash: "1a2b3c4d",
      alert_display: "TypeError in /api/foo",
    });
  });

  it("path / text: maps value → slot", () => {
    expect(
      mergeSlotValue(partial, "path", { kind: "path", value: "D:\\web" }),
    ).toEqual({ path: "D:\\web" });
    expect(
      mergeSlotValue(partial, "message", { kind: "text", value: "hello" }),
    ).toEqual({ message: "hello" });
  });

  it("does not mutate the input partial", () => {
    const collected: Record<string, unknown> = { existing: "x" };
    const inputPartial: PartialCommand = {
      command: "whatsapp",
      collectedArgs: collected,
      rawArgs: "",
    };
    const before = { ...collected };
    mergeSlotValue(inputPartial, "recipient", {
      kind: "contact",
      jid: "+1",
      name: "n",
    });
    expect(collected).toEqual(before);
    expect(collected.existing).toBe("x");
  });

  it("merges atop existing collected args", () => {
    const inputPartial: PartialCommand = {
      command: "whatsapp",
      collectedArgs: { recipient: "+1", recipient_display: "Mom" },
      rawArgs: "Mom",
    };
    const merged = mergeSlotValue(inputPartial, "message", {
      kind: "text",
      value: "hi",
    });
    expect(merged.recipient).toBe("+1");
    expect(merged.recipient_display).toBe("Mom");
    expect(merged.message).toBe("hi");
  });
});

// ── `describeCollected` header rendering ───────────────────────────────────

describe("describeCollected()", () => {
  it("returns empty string when nothing has been collected", () => {
    expect(
      describeCollected({ command: "whatsapp", collectedArgs: {}, rawArgs: "" }),
    ).toBe("");
  });

  it("prefers the *_display companion key over the raw value", () => {
    const result = describeCollected({
      command: "whatsapp",
      collectedArgs: {
        recipient: "+5215512345678",
        recipient_display: "Jose",
      },
      rawArgs: "Jose",
    });
    expect(result).toBe("Jose");
  });

  it("falls back to the raw value when no display is set", () => {
    const result = describeCollected({
      command: "install",
      collectedArgs: { path: "D:\\web" },
      rawArgs: "D:\\web",
    });
    expect(result).toBe("D:\\web");
  });

  it("joins multiple collected args with spaces", () => {
    const result = describeCollected({
      command: "whatsapp",
      collectedArgs: {
        recipient: "+1",
        recipient_display: "Jose",
        message: "hi",
      },
      rawArgs: "",
    });
    expect(result).toContain("Jose");
    expect(result).toContain("hi");
  });

  it("ignores *_display, *_hash, *_path companion keys when iterating", () => {
    const result = describeCollected({
      command: "fix",
      collectedArgs: {
        alert: "a1",
        alert_hash: "1a2b",
        alert_display: "the title",
      },
      rawArgs: "",
    });
    // Should render the title once, not "a1 the title" twice.
    expect(result).toBe("the title");
  });

  it("truncates long values to keep the header on one line", () => {
    const long = "a".repeat(80);
    const result = describeCollected({
      command: "whatsapp",
      collectedArgs: { message: long },
      rawArgs: "",
    });
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.endsWith("…")).toBe(true);
  });

  it("JSON-stringifies non-string values when no display is set", () => {
    const result = describeCollected({
      command: "alerts",
      collectedArgs: { limit: 50 },
      rawArgs: "",
    });
    expect(result).toBe("50");
  });
});

// ── Slot value narrowing (compile-time guard exercised via switch) ─────────

describe("SlotValue narrowing", () => {
  function summarize(value: SlotValue): string {
    switch (value.kind) {
      case "contact":
        return `contact:${value.name}`;
      case "project":
        return `project:${value.name}`;
      case "alert":
        return `alert:${value.title}`;
      case "path":
        return `path:${value.value}`;
      case "text":
        return `text:${value.value}`;
    }
  }

  it("narrows on `kind` so each branch sees its variant fields", () => {
    expect(summarize({ kind: "contact", jid: "+1", name: "Jose" })).toBe(
      "contact:Jose",
    );
    expect(
      summarize({ kind: "project", id: "p1", name: "InariWatch" }),
    ).toBe("project:InariWatch");
    expect(
      summarize({ kind: "alert", id: "a1", hash: "1a", title: "T" }),
    ).toBe("alert:T");
    expect(summarize({ kind: "path", value: "/x" })).toBe("path:/x");
    expect(summarize({ kind: "text", value: "hi" })).toBe("text:hi");
  });
});

// ── `CommandResult` discriminant ───────────────────────────────────────────

describe("CommandResult", () => {
  it("ok | error | suspended are mutually exclusive", () => {
    const ok: CommandResult = { kind: "ok" };
    const err: CommandResult = { kind: "error" };
    const susp: CommandResult = suspend({
      command: "x",
      needs: { kind: "text", name: "y", prompt: "z" },
    });
    expect(ok.kind).toBe("ok");
    expect(err.kind).toBe("error");
    expect(susp.kind).toBe("suspended");
  });
});

// ── `NOOP_SUSPENDED` shape ─────────────────────────────────────────────────

describe("NOOP_SUSPENDED", () => {
  it("never throws regardless of input shape", () => {
    expect(() =>
      NOOP_SUSPENDED({
        needs: { kind: "text", name: "x", prompt: "y" },
        partial: { command: "z", collectedArgs: {}, rawArgs: "" },
        rebuild: () => "/z",
      }),
    ).not.toThrow();
  });

  it("can be substituted into a `SuspendedHandler` parameter", () => {
    const spy = vi.fn(NOOP_SUSPENDED);
    spy({
      needs: { kind: "text", name: "x", prompt: "y" },
      partial: { command: "z", collectedArgs: {}, rawArgs: "" },
      rebuild: () => "/z",
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── Test fixture helper ────────────────────────────────────────────────────

describe("makeSuspendedEchoForTest()", () => {
  it("renders `/cmd` when rawArgs is empty", () => {
    const msg = makeSuspendedEchoForTest("whatsapp", "");
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("/whatsapp");
  });

  it("renders `/cmd args` when rawArgs is non-empty", () => {
    const msg = makeSuspendedEchoForTest("whatsapp", "Jose hi");
    expect(msg.content).toBe("/whatsapp Jose hi");
  });
});
