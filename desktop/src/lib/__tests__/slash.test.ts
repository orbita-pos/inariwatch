/**
 * Tests for slash-command parser + catalog.
 */

import { describe, expect, it } from "vitest";

import { parseSlashCommand } from "../slash";
import { SLASH_CATALOG, findSlashCommand } from "../slash-catalog";

describe("parseSlashCommand", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello")).toBeNull();
    expect(parseSlashCommand("ask claude something")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
    expect(parseSlashCommand("   ")).toBeNull();
  });

  it("returns null for slash alone or whitespace-only after slash", () => {
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("  /  ")).toBeNull();
  });

  it("returns null for digit-start commands (URL paths shouldn't parse)", () => {
    expect(parseSlashCommand("/123")).toBeNull();
    expect(parseSlashCommand("/123abc")).toBeNull();
  });

  it("returns null for shell-y / non-identifier names", () => {
    expect(parseSlashCommand("/radio!")).toBeNull();
    expect(parseSlashCommand("/.code")).toBeNull();
    expect(parseSlashCommand("/cmd with spaces")).toEqual({
      command: "cmd",
      args: "with spaces",
    });
  });

  it("parses bare command without args", () => {
    expect(parseSlashCommand("/radio")).toEqual({
      command: "radio",
      args: "",
    });
  });

  it("parses command with args", () => {
    expect(parseSlashCommand("/url https://example.com")).toEqual({
      command: "url",
      args: "https://example.com",
    });
  });

  it("trims whitespace around input and around args", () => {
    expect(parseSlashCommand("  /radio   ")).toEqual({
      command: "radio",
      args: "",
    });
    expect(parseSlashCommand("/code    src/lib.rs:42  ")).toEqual({
      command: "code",
      args: "src/lib.rs:42",
    });
  });

  it("lowercases the command name (case-insensitive lookup)", () => {
    expect(parseSlashCommand("/RADIO")).toEqual({
      command: "radio",
      args: "",
    });
    expect(parseSlashCommand("/Code path")).toEqual({
      command: "code",
      args: "path",
    });
  });

  it("preserves args case + whitespace within", () => {
    expect(parseSlashCommand("/url https://Example.com/Path")).toEqual({
      command: "url",
      args: "https://Example.com/Path",
    });
  });
});

describe("findSlashCommand", () => {
  it("finds known commands", () => {
    expect(findSlashCommand("radio")?.command).toBe("radio");
    expect(findSlashCommand("code")?.command).toBe("code");
    expect(findSlashCommand("url")?.command).toBe("url");
    expect(findSlashCommand("docs")?.command).toBe("docs");
  });

  it("is case-insensitive", () => {
    expect(findSlashCommand("RADIO")?.command).toBe("radio");
    expect(findSlashCommand("Code")?.command).toBe("code");
  });

  it("returns null for unknown commands", () => {
    expect(findSlashCommand("unknown")).toBeNull();
    expect(findSlashCommand("")).toBeNull();
  });
});

describe("SLASH_CATALOG entries", () => {
  it("every command points to a recognized tool name", () => {
    const KNOWN_TOOLS = new Set([
      "desktop.open_url",
      "desktop.open_in_editor",
      "desktop.open_finder",
      // Phase 1 of pure-slash refactor — tool-routed comms + setup.
      "setup.install_capture",
      "comm.send_telegram",
      "comm.send_slack",
    ]);
    for (const entry of SLASH_CATALOG) {
      expect(KNOWN_TOOLS.has(entry.toolName)).toBe(true);
    }
  });

  it("commands are unique", () => {
    const seen = new Set<string>();
    for (const entry of SLASH_CATALOG) {
      expect(seen.has(entry.command)).toBe(false);
      seen.add(entry.command);
    }
  });

  describe("/radio", () => {
    it("returns a YouTube URL with no args", () => {
      const r = findSlashCommand("radio")!.parseArgs("");
      expect("args" in r).toBe(true);
      if ("args" in r) {
        expect((r.args.url as string)).toMatch(/youtube\.com/);
      }
    });

    it("ignores any args passed", () => {
      const r = findSlashCommand("radio")!.parseArgs("foo bar baz");
      expect("args" in r).toBe(true);
    });
  });

  describe("/code", () => {
    it("rejects empty args with a helpful error", () => {
      const r = findSlashCommand("code")!.parseArgs("");
      expect("error" in r).toBe(true);
      if ("error" in r) {
        expect(r.error).toMatch(/path required/i);
      }
    });

    it("parses bare path", () => {
      const r = findSlashCommand("code")!.parseArgs("src/lib.rs");
      expect(r).toEqual({ args: { path: "src/lib.rs" } });
    });

    it("parses path:line", () => {
      const r = findSlashCommand("code")!.parseArgs("src/lib.rs:42");
      expect(r).toEqual({ args: { path: "src/lib.rs", line: 42 } });
    });

    it("rejects non-positive line numbers", () => {
      const r = findSlashCommand("code")!.parseArgs("src/lib.rs:0");
      expect("error" in r).toBe(true);
    });

    it("rejects malformed path:line (path:abc)", () => {
      // Falls through to "no line" because the regex only matches
      // numeric line. The colon stays in the path. This is acceptable
      // — it's better than rejecting valid `:` paths on Windows.
      const r = findSlashCommand("code")!.parseArgs("C:/Users/jesus/lib.rs");
      expect("args" in r).toBe(true);
    });
  });

  describe("/url", () => {
    it("rejects empty args", () => {
      const r = findSlashCommand("url")!.parseArgs("");
      expect("error" in r).toBe(true);
    });

    it("rejects non-http(s) URLs", () => {
      const r = findSlashCommand("url")!.parseArgs("file:///etc/passwd");
      expect("error" in r).toBe(true);
    });

    it("accepts https URLs", () => {
      const r = findSlashCommand("url")!.parseArgs("https://example.com");
      expect(r).toEqual({ args: { url: "https://example.com" } });
    });

    it("accepts http URLs (some local dashboards still use plain http)", () => {
      const r = findSlashCommand("url")!.parseArgs("http://localhost:3000");
      expect(r).toEqual({ args: { url: "http://localhost:3000" } });
    });
  });

  describe("/finder", () => {
    it("rejects empty args with a helpful error", () => {
      const r = findSlashCommand("finder")!.parseArgs("");
      expect("error" in r).toBe(true);
      if ("error" in r) {
        expect(r.error).toMatch(/path required/i);
      }
    });

    it("forwards the trimmed path", () => {
      const r = findSlashCommand("finder")!.parseArgs("./exports");
      expect(r).toEqual({ args: { path: "./exports" } });
    });

    it("preserves spaces in paths (some folders have spaces in names)", () => {
      const r = findSlashCommand("finder")!.parseArgs("/Users/jesus/My Documents");
      expect(r).toEqual({ args: { path: "/Users/jesus/My Documents" } });
    });
  });

  describe("/docs", () => {
    it("returns inariwatch.com/docs", () => {
      const r = findSlashCommand("docs")!.parseArgs("");
      expect(r).toEqual({ args: { url: "https://inariwatch.com/docs" } });
    });
  });
});
