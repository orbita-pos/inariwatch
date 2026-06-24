/**
 * Parser tests for the new catalog entries added in Phase 1 of the
 * pure-slash refactor: `/install`, `/telegram`, `/slack`. The
 * dispatcher's generic flow (catalog lookup → IPC → summary note) is
 * already covered by `slash-dispatch.test.ts`; this file locks the
 * per-command argument shape so a regression in parseArgs doesn't
 * silently misroute a tool call.
 */

import { describe, expect, it } from "vitest";

import { SLASH_CATALOG, findSlashCommand } from "../slash-catalog";

function parse(command: string, rawArgs: string) {
  const entry = findSlashCommand(command);
  if (!entry) throw new Error(`unknown command: /${command}`);
  return entry.parseArgs(rawArgs);
}

// ── /install ───────────────────────────────────────────────────────────────

describe("/install parseArgs", () => {
  it("requires a path", () => {
    const r = parse("install", "");
    expect("error" in r).toBe(true);
  });

  it("rejects relative paths", () => {
    const r = parse("install", "./my-app");
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toMatch(/absolute/i);
    }
  });

  it("accepts a Windows-style absolute path", () => {
    const r = parse("install", "C:\\code\\my-app");
    expect("args" in r).toBe(true);
    if ("args" in r) {
      expect(r.args).toEqual({ repo_path: "C:\\code\\my-app" });
    }
  });

  it("accepts a POSIX absolute path", () => {
    const r = parse("install", "/home/me/api");
    expect("args" in r).toBe(true);
    if ("args" in r) {
      expect(r.args).toEqual({ repo_path: "/home/me/api" });
    }
  });

  it("extracts --project=<id> when present", () => {
    const r = parse("install", "/repo --project=p-abc-123");
    expect("args" in r).toBe(true);
    if ("args" in r) {
      expect(r.args).toEqual({
        repo_path: "/repo",
        project_id: "p-abc-123",
      });
    }
  });

  it("accepts --project=<id> in any position relative to the path", () => {
    const r = parse("install", "--project=p-abc /repo");
    expect("args" in r).toBe(true);
    if ("args" in r) {
      expect(r.args).toEqual({
        repo_path: "/repo",
        project_id: "p-abc",
      });
    }
  });
});

// ── /telegram ──────────────────────────────────────────────────────────────

describe("/telegram parseArgs", () => {
  it("requires both chat_id and message", () => {
    expect("error" in parse("telegram", "")).toBe(true);
    expect("error" in parse("telegram", "@user")).toBe(true);
  });

  it("forwards chat_id + message as the tool's wire shape", () => {
    const r = parse("telegram", "@inari_oncall Heads up");
    expect("args" in r).toBe(true);
    if ("args" in r) {
      expect(r.args).toEqual({
        chat_id: "@inari_oncall",
        text: "Heads up",
      });
    }
  });

  it("accepts numeric chat ids", () => {
    const r = parse("telegram", "123456789 Hi");
    if ("args" in r) {
      expect(r.args).toEqual({ chat_id: "123456789", text: "Hi" });
    }
  });

  it("preserves multi-word message body verbatim", () => {
    const r = parse("telegram", "@u This message has  multiple  spaces");
    if ("args" in r) {
      // Inner spaces preserved; trailing/leading trimmed.
      expect(r.args.text).toBe("This message has  multiple  spaces");
    }
  });
});

// ── /slack ─────────────────────────────────────────────────────────────────

describe("/slack parseArgs", () => {
  it("requires both channel and text", () => {
    expect("error" in parse("slack", "")).toBe(true);
    expect("error" in parse("slack", "#alerts")).toBe(true);
  });

  it("forwards channel + text as the tool's wire shape", () => {
    const r = parse("slack", "#alerts Deploy is degraded");
    expect("args" in r).toBe(true);
    if ("args" in r) {
      expect(r.args).toEqual({
        channel: "#alerts",
        text: "Deploy is degraded",
      });
    }
  });

  it("accepts uppercase channel ids", () => {
    const r = parse("slack", "C0123ABC Heads up");
    if ("args" in r) {
      expect(r.args.channel).toBe("C0123ABC");
    }
  });
});

// ── Catalog hygiene ────────────────────────────────────────────────────────

describe("SLASH_CATALOG hygiene", () => {
  it("contains the three new entries added in phase 1", () => {
    const names = SLASH_CATALOG.map((e) => e.command);
    expect(names).toContain("install");
    expect(names).toContain("telegram");
    expect(names).toContain("slack");
  });

  it("every catalog entry has a non-empty description", () => {
    for (const entry of SLASH_CATALOG) {
      expect(entry.description.length, entry.command).toBeGreaterThan(0);
    }
  });

  it("every catalog entry's parseArgs is a function", () => {
    for (const entry of SLASH_CATALOG) {
      expect(typeof entry.parseArgs).toBe("function");
    }
  });
});
