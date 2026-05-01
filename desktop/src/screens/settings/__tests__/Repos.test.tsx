import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetSettingsStoreForTests, useSettings } from "@/lib/store/settings";
import { SettingsRepos } from "@/screens/settings/Repos";
import type { RepoSummary } from "@/lib/main-ipc";

const wipeRepoMemoryMock = vi.fn();

vi.mock("@/lib/main-ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/main-ipc")>();
  return {
    ...actual,
    getReposList: vi.fn(async () => REPOS_FIXTURE),
    wipeRepoMemory: (...args: unknown[]) => wipeRepoMemoryMock(...args),
  };
});

const REPOS_FIXTURE: RepoSummary[] = [
  {
    id: "repo-aaaa",
    path: "/tmp/repo-a",
    name: "repo-a",
    opened_at_ms: Date.now() - 60_000,
    last_indexed_at_ms: Date.now() - 30_000,
    indexed_file_count: 12,
    symbol_count: 384,
    replay_enabled: false,
  },
  {
    id: "repo-bbbb",
    path: "/tmp/repo-b",
    name: "repo-b",
    opened_at_ms: Date.now() - 120_000,
    last_indexed_at_ms: null,
    indexed_file_count: 0,
    symbol_count: 0,
    replay_enabled: true,
  },
];

describe("SettingsRepos", () => {
  beforeEach(() => {
    __resetSettingsStoreForTests();
    wipeRepoMemoryMock.mockReset();
    wipeRepoMemoryMock.mockResolvedValue({
      repo_id: "repo-aaaa",
      symbols: 384,
      embeddings: 384,
      events: 0,
      patterns: 0,
    });
    useSettings.setState({ repos: REPOS_FIXTURE });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Wipe memory shows confirmation dialog and calls IPC on confirm", async () => {
    render(<SettingsRepos />);

    expect(screen.getByTestId("repo-row-repo-aaaa")).toBeInTheDocument();
    expect(screen.getByTestId("repo-row-repo-bbbb")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("wipe-button-repo-aaaa"));
    });

    // Dialog open — confirm copy mentions the repo name + memory.md preservation.
    const confirmButton = screen.getByTestId("wipe-confirm");
    expect(screen.getAllByText(/repo-a/).length).toBeGreaterThan(0);
    expect(screen.getByText(/memory\.md will be preserved/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(confirmButton);
    });

    expect(wipeRepoMemoryMock).toHaveBeenCalledWith("repo-aaaa");
  });
});
