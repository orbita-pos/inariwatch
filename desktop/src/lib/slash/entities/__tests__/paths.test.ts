/**
 * Phase 5.2 — recent-paths entity provider tests.
 *
 * Stubs the Tauri `invoke` IPC and asserts the snake_case → camelCase
 * mapping plus the silent-failure contract (vitest / jsdom should
 * never see a chat-surface error).
 */
import { describe, expect, it, vi } from "vitest";

import {
  listRecentPaths,
  recordRecentPath,
} from "../paths";

interface RawRow {
  path: string;
  last_used_at: number;
}

describe("listRecentPaths()", () => {
  it("maps snake_case rows to camelCase entities", async () => {
    const rows: RawRow[] = [
      { path: "D:\\web", last_used_at: 2_000 },
      { path: "C:\\Users\\jesus\\repo", last_used_at: 1_000 },
    ];
    const invoke = vi.fn(async () => rows as unknown) as never;
    const result = await listRecentPaths(10, { invoke });
    expect(result).toEqual([
      { path: "D:\\web", lastUsedAt: 2_000 },
      { path: "C:\\Users\\jesus\\repo", lastUsedAt: 1_000 },
    ]);
  });

  it("forwards the limit verbatim", async () => {
    const invoke = vi.fn(async () => [] as unknown) as never;
    await listRecentPaths(5, { invoke });
    expect(invoke).toHaveBeenCalledWith("desktop_recent_paths_list", {
      limit: 5,
    });
  });

  it("uses default limit=10 when none provided", async () => {
    const invoke = vi.fn(async () => [] as unknown) as never;
    await listRecentPaths(undefined, { invoke });
    expect(invoke).toHaveBeenCalledWith("desktop_recent_paths_list", {
      limit: 10,
    });
  });

  it("degrades to empty list when IPC throws", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("not paired");
    }) as never;
    const result = await listRecentPaths(10, { invoke });
    expect(result).toEqual([]);
  });
});

describe("recordRecentPath()", () => {
  it("forwards the path verbatim and returns true on success", async () => {
    const invoke = vi.fn(async () => undefined as unknown) as never;
    const ok = await recordRecentPath("D:\\web", { invoke });
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("desktop_recent_paths_add", {
      path: "D:\\web",
    });
  });

  it("trims whitespace before recording", async () => {
    const invoke = vi.fn(async () => undefined as unknown) as never;
    await recordRecentPath("   D:\\web   ", { invoke });
    expect(invoke).toHaveBeenCalledWith("desktop_recent_paths_add", {
      path: "D:\\web",
    });
  });

  it("returns false (silent no-op) when path is empty after trim", async () => {
    const invoke = vi.fn(async () => undefined as unknown) as never;
    const ok = await recordRecentPath("   ", { invoke });
    expect(ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns false (best-effort) when IPC throws", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("store full");
    }) as never;
    const ok = await recordRecentPath("D:\\web", { invoke });
    expect(ok).toBe(false);
  });
});
