/**
 * suggest-ipc — frontend wrapper for the `suggest_slash_commands`
 * Tauri IPC.
 *
 * Mocks `@tauri-apps/api/core` so the wrapper's defensive try/catch
 * + array guards can be exercised without a live Tauri runtime.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const invokeMock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock.invoke,
}));

import {
  manifestForSuggest,
  suggestSlashCommands,
  type SlashSuggestion,
} from "../suggest-ipc";
import { SLASH_MANIFEST } from "../manifest";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("suggestSlashCommands", () => {
  it("returns [] without an IPC call when the query is empty", async () => {
    const result = await suggestSlashCommands("");
    expect(result).toEqual([]);
    expect(invokeMock.invoke).not.toHaveBeenCalled();
  });

  it("returns [] without an IPC call when the query is whitespace", async () => {
    const result = await suggestSlashCommands("   \t  ");
    expect(result).toEqual([]);
    expect(invokeMock.invoke).not.toHaveBeenCalled();
  });

  it("forwards the trimmed query + serialised manifest to the IPC", async () => {
    invokeMock.invoke.mockResolvedValueOnce([]);
    await suggestSlashCommands("  show me projects  ");
    expect(invokeMock.invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.invoke.mock.calls[0]!;
    expect(cmd).toBe("suggest_slash_commands");
    expect(args).toMatchObject({ query: "show me projects" });
    expect(Array.isArray((args as { manifest: unknown }).manifest)).toBe(true);
  });

  it("returns the IPC payload verbatim when it is a valid array", async () => {
    const fixture: SlashSuggestion[] = [
      {
        command: "/projects --integration=capture",
        rationale: "matches the query",
        confidence: 0.91,
      },
    ];
    invokeMock.invoke.mockResolvedValueOnce(fixture);
    const result = await suggestSlashCommands("proyectos con capture");
    expect(result).toEqual(fixture);
  });

  it("returns [] when the IPC rejects (Tauri unavailable / runtime error)", async () => {
    invokeMock.invoke.mockRejectedValueOnce(new Error("ipc unavailable"));
    const result = await suggestSlashCommands("anything");
    expect(result).toEqual([]);
  });

  it("returns [] when the IPC resolves to a non-array shape", async () => {
    // Defensive: Tauri should never hand back a non-array, but a
    // future protocol drift shouldn't poison the caller.
    invokeMock.invoke.mockResolvedValueOnce({ unexpected: "shape" });
    const result = await suggestSlashCommands("anything");
    expect(result).toEqual([]);
  });

  // ── Phase 5.4 — memoryContext forwarding ──────────────────────────────

  it("forwards an explicit memoryContext to the IPC", async () => {
    invokeMock.invoke.mockResolvedValueOnce([]);
    await suggestSlashCommands("fixea la del payment", {
      memoryContext: "Recent context: alert_abc (payment timeout 12:01)",
    });
    const [, args] = invokeMock.invoke.mock.calls[0]!;
    expect((args as { memoryContext: unknown }).memoryContext).toBe(
      "Recent context: alert_abc (payment timeout 12:01)",
    );
  });

  it("sends memoryContext=null when the option is omitted", async () => {
    invokeMock.invoke.mockResolvedValueOnce([]);
    await suggestSlashCommands("show me alerts");
    const [, args] = invokeMock.invoke.mock.calls[0]!;
    expect((args as { memoryContext: unknown }).memoryContext).toBeNull();
  });

  it("sends memoryContext=null when the option is empty / whitespace", async () => {
    invokeMock.invoke.mockResolvedValueOnce([]);
    await suggestSlashCommands("x", { memoryContext: "   \n  " });
    const [, args] = invokeMock.invoke.mock.calls[0]!;
    expect((args as { memoryContext: unknown }).memoryContext).toBeNull();
  });
});

describe("manifestForSuggest", () => {
  it("returns one entry per SLASH_MANIFEST entry", () => {
    const out = manifestForSuggest();
    expect(out).toHaveLength(SLASH_MANIFEST.length);
  });

  it("preserves name, description, and args; drops examples", () => {
    const out = manifestForSuggest();
    for (let i = 0; i < out.length; i++) {
      expect(out[i]!.name).toBe(SLASH_MANIFEST[i]!.name);
      expect(out[i]!.description).toBe(SLASH_MANIFEST[i]!.description);
      expect(out[i]!.args).toEqual(SLASH_MANIFEST[i]!.args);
      // examples are intentionally dropped to keep the IPC payload
      // small — the LLM doesn't need them for inference.
      expect(out[i]!.examples).toEqual([]);
    }
  });
});
