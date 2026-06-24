/**
 * S13 — vitest coverage for SearchPanel.
 *
 * The panel takes an `invoker` prop (test seam) so we can inject a
 * stub instead of mocking the IPC module. Same pattern as ReplayButton.
 *
 * What we lock here:
 *
 * 1. Renders N hits from a mock response → cards in DOM, count chip
 *    shows N of N.
 * 2. Loading state renders 3 skeleton cards.
 * 3. Empty state when hits.length === 0 — empty CTA in DOM.
 * 4. Error state shows message + Retry button; Retry re-fires the
 *    invoker.
 * 5. Filter chips toggle source visibility — clicking GitHub when
 *    only stack_overflow + mdn remain hides the GH card. Toggling
 *    back shows it again.
 * 6. "Open in browser" calls the SearchResultCard's `onOpen` (we
 *    render the card with a spy directly to keep this isolated from
 *    the dynamic `import('@tauri-apps/plugin-shell')`).
 * 7. quota_low flag renders the Stack Overflow warning chip.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SearchPanel } from "@/components/search/SearchPanel";
import { SearchResultCard } from "@/components/search/SearchResultCard";
import type { Hit, SearchResponse } from "@/lib/inari-search-ipc";
import { SearchError } from "@/lib/inari-search-ipc";

// ── Fixtures ─────────────────────────────────────────────────────────

function soHit(i: number): Hit {
  return {
    title: `SO answer ${i}`,
    url: `https://stackoverflow.com/questions/${i}`,
    excerpt: `try checking with optional chaining ${i}`,
    source: "stack_overflow",
    score: 0.9,
    meta: {
      source: "stack_overflow",
      vote_count: 100 + i,
      is_accepted: i === 0,
      answer_count: 3,
    },
  };
}

function ghHit(i: number): Hit {
  return {
    title: `GH issue ${i}`,
    url: `https://github.com/owner/repo/issues/${i}`,
    excerpt: `repro on v2.${i}`,
    source: "github",
    score: 0.5,
    meta: {
      source: "github",
      reaction_count: 12,
      comment_count: 4,
      state: "closed",
    },
  };
}

function mdnHit(i: number): Hit {
  return {
    title: `MDN ${i}`,
    url: `https://developer.mozilla.org/en-US/docs/Web/X${i}`,
    excerpt: `the TypeError represents...`,
    source: "mdn",
    score: 1.0,
    meta: { source: "mdn", is_deprecated: false },
  };
}

function fixtureResponse(): SearchResponse {
  return {
    hits: [soHit(0), ghHit(0), mdnHit(0)],
    sources_used: [
      { source: "stack_overflow", state: { kind: "ok", hit_count: 1 } },
      { source: "github", state: { kind: "ok", hit_count: 1 } },
      { source: "mdn", state: { kind: "ok", hit_count: 1 } },
    ],
    cache_status: "miss",
    elapsed_ms: 412,
    quota_low: false,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("SearchPanel", () => {
  it("renders N hits from a successful invoker response", async () => {
    const invoker = vi.fn(async () => fixtureResponse());
    render(<SearchPanel errorText="TypeError" invoker={invoker} />);

    await waitFor(() => {
      expect(screen.getByTestId("search-panel-results")).toBeInTheDocument();
    });
    expect(invoker).toHaveBeenCalledWith("TypeError", undefined);

    expect(screen.getByTestId("search-result-stack_overflow")).toBeInTheDocument();
    expect(screen.getByTestId("search-result-github")).toBeInTheDocument();
    expect(screen.getByTestId("search-result-mdn")).toBeInTheDocument();
    expect(screen.getByTestId("search-panel-count")).toHaveTextContent(/3 of 3/);
  });

  it("renders 3 skeleton cards while loading", () => {
    // Invoker that never resolves → stays in loading.
    const invoker = vi.fn(() => new Promise<SearchResponse>(() => {}));
    render(<SearchPanel errorText="x" invoker={invoker} />);
    const skeleton = screen.getByTestId("search-panel-skeleton");
    expect(skeleton.children.length).toBe(3);
    expect(screen.getByTestId("search-panel-loading-summary")).toHaveTextContent(/Searching/);
  });

  it("renders the empty state when zero hits returned", async () => {
    const empty: SearchResponse = {
      hits: [],
      sources_used: [
        { source: "stack_overflow", state: { kind: "ok", hit_count: 0 } },
      ],
      cache_status: "miss",
      elapsed_ms: 200,
      quota_low: false,
    };
    const invoker = vi.fn(async () => empty);
    render(<SearchPanel errorText="rare-error" invoker={invoker} />);
    await waitFor(() => {
      expect(screen.getByTestId("search-panel-empty")).toBeInTheDocument();
    });
    expect(screen.getByTestId("search-panel-empty")).toHaveTextContent(
      /No matching sources/i,
    );
  });

  it("renders the error state and retries on Retry click", async () => {
    let calls = 0;
    const invoker = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new SearchError("boom", "transport");
      return fixtureResponse();
    });
    render(<SearchPanel errorText="x" invoker={invoker} />);

    await waitFor(() => {
      expect(screen.getByTestId("search-panel-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("search-panel-error")).toHaveTextContent(/boom/);

    act(() => {
      fireEvent.click(screen.getByTestId("search-panel-error-retry"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("search-panel-results")).toBeInTheDocument();
    });
    expect(invoker).toHaveBeenCalledTimes(2);
  });

  it("renders denied-state distinctly when SearchError.kind == 'denied'", async () => {
    const invoker = vi.fn(async () => {
      throw new SearchError("permission denied", "denied");
    });
    render(<SearchPanel errorText="x" invoker={invoker} />);
    await waitFor(() => {
      expect(screen.getByTestId("search-panel-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("search-panel-error")).toHaveTextContent(
      /denied in Settings/i,
    );
    // Denied state hides the Retry button (re-firing won't help).
    expect(screen.queryByTestId("search-panel-error-retry")).not.toBeInTheDocument();
  });

  it("filter chip toggles source visibility without re-firing the invoker", async () => {
    const invoker = vi.fn(async () => fixtureResponse());
    render(<SearchPanel errorText="x" invoker={invoker} />);
    await waitFor(() => {
      expect(screen.getByTestId("search-result-github")).toBeInTheDocument();
    });

    // Click the GitHub chip to deselect it.
    act(() => {
      fireEvent.click(screen.getByTestId("source-chip-github"));
    });

    expect(screen.queryByTestId("search-result-github")).not.toBeInTheDocument();
    expect(screen.getByTestId("search-result-stack_overflow")).toBeInTheDocument();
    expect(screen.getByTestId("search-result-mdn")).toBeInTheDocument();
    expect(screen.getByTestId("search-panel-count")).toHaveTextContent(/2 of 3/);

    // Toggle back.
    act(() => {
      fireEvent.click(screen.getByTestId("source-chip-github"));
    });
    expect(screen.getByTestId("search-result-github")).toBeInTheDocument();

    // Invoker only fired once (initial render) — chips are local-only.
    expect(invoker).toHaveBeenCalledTimes(1);
  });

  it("does not allow toggling all chips off (must keep at least one)", async () => {
    const invoker = vi.fn(async () => fixtureResponse());
    render(<SearchPanel errorText="x" invoker={invoker} />);
    await waitFor(() => {
      expect(screen.getByTestId("search-result-stack_overflow")).toBeInTheDocument();
    });
    // Turn off SO and GH — MDN must stay on.
    act(() => {
      fireEvent.click(screen.getByTestId("source-chip-stack_overflow"));
      fireEvent.click(screen.getByTestId("source-chip-github"));
      // Try to turn off the last one — should be a no-op.
      fireEvent.click(screen.getByTestId("source-chip-mdn"));
    });
    expect(screen.getByTestId("source-chip-mdn")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("search-result-mdn")).toBeInTheDocument();
  });

  it("renders the quota_low warning when the SO quota is nearly exhausted", async () => {
    const r = fixtureResponse();
    r.quota_low = true;
    const invoker = vi.fn(async () => r);
    render(<SearchPanel errorText="x" invoker={invoker} />);
    await waitFor(() => {
      expect(screen.getByTestId("search-panel-quota-low")).toBeInTheDocument();
    });
  });

  it("forwards SearchOptions to the invoker", async () => {
    const invoker = vi.fn(async () => fixtureResponse());
    render(
      <SearchPanel
        errorText="TypeError"
        options={{ language: "javascript", framework: "react", max_hits: 15 }}
        invoker={invoker}
      />,
    );
    await waitFor(() => {
      expect(invoker).toHaveBeenCalledWith("TypeError", {
        language: "javascript",
        framework: "react",
        max_hits: 15,
      });
    });
  });

  it("collapses requires_confirm response into the error state", async () => {
    const invoker = vi.fn(async () => ({ kind: "requires_confirm" as const }));
    render(<SearchPanel errorText="x" invoker={invoker} />);
    await waitFor(() => {
      expect(screen.getByTestId("search-panel-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("search-panel-error")).toHaveTextContent(
      /require confirmation/i,
    );
  });
});

describe("SearchResultCard", () => {
  it("invokes onOpen with the hit URL when the title is clicked", () => {
    const onOpen = vi.fn();
    render(<SearchResultCard hit={soHit(0)} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("search-result-title"));
    expect(onOpen).toHaveBeenCalledWith("https://stackoverflow.com/questions/0");
  });

  it("invokes onOpen with the hit URL when the open icon is clicked", () => {
    const onOpen = vi.fn();
    render(<SearchResultCard hit={ghHit(0)} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("search-result-open"));
    expect(onOpen).toHaveBeenCalledWith("https://github.com/owner/repo/issues/0");
  });

  it("renders SO meta chips (votes + accepted + answers)", () => {
    render(<SearchResultCard hit={soHit(0)} onOpen={vi.fn()} />);
    expect(screen.getByTestId("meta-votes")).toHaveTextContent(/100 votes/);
    expect(screen.getByTestId("meta-accepted")).toBeInTheDocument();
    expect(screen.getByTestId("meta-answers")).toHaveTextContent(/3 answers/);
  });

  it("renders GitHub meta chips (reactions + comments + state)", () => {
    render(<SearchResultCard hit={ghHit(0)} onOpen={vi.fn()} />);
    expect(screen.getByTestId("meta-reactions")).toHaveTextContent(/12 reactions/);
    expect(screen.getByTestId("meta-comments")).toHaveTextContent(/4 comments/);
    expect(screen.getByTestId("meta-state")).toHaveTextContent(/closed/);
  });

  it("renders source badge with the brand label", () => {
    const { rerender } = render(<SearchResultCard hit={soHit(0)} onOpen={vi.fn()} />);
    expect(screen.getByLabelText("Source: Stack Overflow")).toBeInTheDocument();

    rerender(<SearchResultCard hit={ghHit(0)} onOpen={vi.fn()} />);
    expect(screen.getByLabelText("Source: GitHub")).toBeInTheDocument();

    rerender(<SearchResultCard hit={mdnHit(0)} onOpen={vi.fn()} />);
    expect(screen.getByLabelText("Source: MDN")).toBeInTheDocument();
  });
});
