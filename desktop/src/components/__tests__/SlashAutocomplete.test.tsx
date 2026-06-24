/**
 * Tests for SlashAutocomplete + filterSlashMatches.
 *
 * Keyboard navigation lives in the parent (DockConversation) and is
 * covered by an integration test there. This file covers the pure
 * filter function + the dumb-display component for BOTH modes:
 *   - deterministic (`matches`) → Phase 1 slash dropdown
 *   - AI (`suggestions`)         → Phase 2 autocomplete
 *
 * The two modes share keyboard semantics but render different rows
 * (AI rows have the model's rationale and an "AI" badge).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  SlashAutocomplete,
  filterSlashMatches,
  type SlashSuggestion,
} from "../SlashAutocomplete";
import { SLASH_DISPLAY } from "@/lib/slash-catalog";

describe("filterSlashMatches", () => {
  it("returns empty for non-slash input", () => {
    expect(filterSlashMatches("hello", SLASH_DISPLAY)).toEqual([]);
    expect(filterSlashMatches("", SLASH_DISPLAY)).toEqual([]);
  });

  it("returns the full catalog for the bare slash", () => {
    const matches = filterSlashMatches("/", SLASH_DISPLAY);
    expect(matches).toHaveLength(SLASH_DISPLAY.length);
  });

  it("filters by prefix", () => {
    // Phase 1 added /resolve and /reopen (V1 conversation lifecycle
    // commands), so `/r` matches them alongside /radio. The expected
    // set is asserted by membership rather than exact equality so a
    // future command starting with `r` doesn't break this test —
    // the contract is "every matching command shows up", not "this
    // exact list of three".
    const matches = filterSlashMatches("/r", SLASH_DISPLAY).map((e) => e.command);
    expect(matches).toContain("radio");
    expect(matches).toContain("resolve");
    expect(matches).toContain("reopen");
    for (const cmd of matches) {
      expect(cmd.startsWith("r")).toBe(true);
    }
  });

  it("returns empty when prefix matches nothing", () => {
    expect(filterSlashMatches("/zzz", SLASH_DISPLAY)).toEqual([]);
  });

  it("hides once whitespace appears (user is typing args)", () => {
    expect(filterSlashMatches("/url ", SLASH_DISPLAY)).toEqual([]);
    expect(filterSlashMatches("/url https://example.com", SLASH_DISPLAY)).toEqual([]);
    expect(filterSlashMatches("/code\tsrc/lib.rs", SLASH_DISPLAY)).toEqual([]);
  });

  it("is case-insensitive on the prefix", () => {
    const matches = filterSlashMatches("/RAD", SLASH_DISPLAY);
    expect(matches.map((e) => e.command)).toEqual(["radio"]);
  });
});

describe("SlashAutocomplete", () => {
  it("renders nothing when matches is empty", () => {
    const { container } = render(
      <SlashAutocomplete matches={[]} selectedIdx={0} onSelect={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one row per match", () => {
    render(
      <SlashAutocomplete
        matches={SLASH_DISPLAY}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    for (const entry of SLASH_DISPLAY) {
      expect(
        screen.getByTestId(`slash-suggestion-${entry.command}`),
      ).toBeInTheDocument();
    }
  });

  it("marks the selected row with aria-selected", () => {
    render(
      <SlashAutocomplete
        matches={SLASH_DISPLAY}
        selectedIdx={1}
        onSelect={() => {}}
      />,
    );
    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveAttribute("aria-selected", "false");
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
    expect(rows[2]).toHaveAttribute("aria-selected", "false");
  });

  it("calls onSelect with the index when a row is clicked", () => {
    const onSelect = vi.fn();
    render(
      <SlashAutocomplete
        matches={SLASH_DISPLAY}
        selectedIdx={0}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("slash-suggestion-radio"));
    expect(onSelect).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByTestId(`slash-suggestion-${SLASH_DISPLAY[2]!.command}`));
    expect(onSelect).toHaveBeenLastCalledWith(2);
  });

  it("renders the command name + description for each row", () => {
    render(
      <SlashAutocomplete
        matches={SLASH_DISPLAY.slice(0, 2)}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(`/${SLASH_DISPLAY[0]!.command}`)).toBeInTheDocument();
    expect(screen.getByText(SLASH_DISPLAY[0]!.description)).toBeInTheDocument();
    expect(screen.getByText(`/${SLASH_DISPLAY[1]!.command}`)).toBeInTheDocument();
    expect(screen.getByText(SLASH_DISPLAY[1]!.description)).toBeInTheDocument();
  });

  it("has correct ARIA listbox role", () => {
    render(
      <SlashAutocomplete
        matches={SLASH_DISPLAY.slice(0, 1)}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("listbox")).toHaveAttribute(
      "aria-label",
      "Slash command suggestions",
    );
  });

  it("paints the slash label with the entry's brand tone when set", () => {
    const tinted: typeof SLASH_DISPLAY = [
      { command: "whatsapp", description: "Send via WhatsApp", tone: "#25D366" },
      { command: "help", description: "Show this list" },
    ];
    render(
      <SlashAutocomplete matches={tinted} selectedIdx={0} onSelect={() => {}} />,
    );
    // Phase 4.5 — the label text now lives inside a nested
    // `<span data-testid="row-label-…">` to support the substring
    // highlighter; the brand tone is applied to the outer
    // `.palette-row__label` ancestor so the entire label inherits the
    // color. Walk up to assert against that ancestor.
    const waText = screen.getByText("/whatsapp");
    const waLabel = waText.closest(".palette-row__label");
    expect(waLabel?.getAttribute("style") ?? "").toMatch(/#25D366|rgb/i);

    const helpText = screen.getByText("/help");
    const helpLabel = helpText.closest(".palette-row__label");
    // Toneless entries fall back to var(--text).
    expect(helpLabel?.getAttribute("style") ?? "").toMatch(/var\(--text\)/);
  });

  it("autocomplete includes every P0 meta + catalog command", () => {
    // Regression — adding a new command without an entry here would
    // make it invisible from the dropdown even if the dispatcher
    // wired the handler.
    const required = [
      // Catalog
      "radio", "code", "url", "finder", "docs", "open",
      // Meta — branded
      "github", "whatsapp",
      // Meta — utility (P0 batch)
      "new", "clear", "settings", "audit", "devices", "theme", "voice",
      "help",
    ];
    for (const cmd of required) {
      expect(SLASH_DISPLAY.some((e) => e.command === cmd)).toBe(true);
    }
  });
});

// ── Phase 2: AI-suggestion rendering ───────────────────────────────────────

describe("SlashAutocomplete — AI mode", () => {
  const fixture: SlashSuggestion[] = [
    {
      command: "/projects --integration=capture",
      rationale: "matches 'projects with capture'",
      confidence: 0.91,
    },
    {
      command: "/alerts 50",
      rationale: "alternative read of the query",
      confidence: 0.42,
    },
  ];

  it("renders one row per AI suggestion when matches is empty", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        suggestions={fixture}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("ai-suggestion-0")).toBeInTheDocument();
    expect(screen.getByTestId("ai-suggestion-1")).toBeInTheDocument();
  });

  it("renders the full command and rationale per row", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        suggestions={fixture}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByText("/projects --integration=capture"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("matches 'projects with capture'"),
    ).toBeInTheDocument();
    expect(screen.getByText("/alerts 50")).toBeInTheDocument();
  });

  it("renders an AI badge on every suggestion row", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        suggestions={fixture}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    const badges = screen.getAllByTestId("ai-suggestion-badge");
    expect(badges).toHaveLength(fixture.length);
  });

  it("calls onSelect with the row index on click", () => {
    const onSelect = vi.fn();
    render(
      <SlashAutocomplete
        matches={[]}
        suggestions={fixture}
        selectedIdx={0}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("ai-suggestion-1"));
    expect(onSelect).toHaveBeenLastCalledWith(1);
  });

  it("renders 'No command matches' when aiEmpty && !aiLoading", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        suggestions={[]}
        aiEmpty
        aiLoading={false}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("ai-suggestion-empty")).toBeInTheDocument();
    // Hint text mentions /help so users know how to discover commands.
    expect(screen.getByTestId("ai-suggestion-empty").textContent).toMatch(/\/help/);
  });

  it("renders nothing while AI loading + no prior suggestions", () => {
    const { container } = render(
      <SlashAutocomplete
        matches={[]}
        suggestions={[]}
        aiEmpty={false}
        aiLoading
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("suppresses the empty placeholder while still loading", () => {
    // Defensive: aiEmpty + aiLoading at the same time shouldn't
    // happen (parent flips aiEmpty=true only when loading=false),
    // but if it ever does, loading wins so the user doesn't see a
    // flash of "no match" before suggestions arrive.
    const { container } = render(
      <SlashAutocomplete
        matches={[]}
        suggestions={[]}
        aiEmpty
        aiLoading
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("deterministic matches win when both are supplied (defensive)", () => {
    render(
      <SlashAutocomplete
        matches={SLASH_DISPLAY.slice(0, 1)}
        suggestions={fixture}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    // Deterministic row visible…
    expect(
      screen.getByTestId(`slash-suggestion-${SLASH_DISPLAY[0]!.command}`),
    ).toBeInTheDocument();
    // …AI rows hidden.
    expect(screen.queryByTestId("ai-suggestion-0")).toBeNull();
  });

  it("highlights the selected AI row via aria-selected", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        suggestions={fixture}
        selectedIdx={1}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("ai-suggestion-0")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByTestId("ai-suggestion-1")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

// ── Phase 4.1: arg-enum dropdown ───────────────────────────────────────────

describe("SlashAutocomplete — arg-enum mode (Phase 4.1)", () => {
  const enumFixture = ["capture", "github", "vercel"] as const;

  it("renders one row per enum value when no other mode is active", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        enumOptions={enumFixture}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("enum-option-0")).toHaveTextContent("capture");
    expect(screen.getByTestId("enum-option-1")).toHaveTextContent("github");
    expect(screen.getByTestId("enum-option-2")).toHaveTextContent("vercel");
  });

  it("renders the optional header label above the rows", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        enumOptions={enumFixture}
        enumHeader="integration"
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("slash-autocomplete-header")).toHaveTextContent(
      "integration",
    );
  });

  it("highlights the selected enum row via aria-selected", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        enumOptions={enumFixture}
        selectedIdx={2}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("enum-option-0")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByTestId("enum-option-2")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("does NOT render an AI badge for enum rows", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        enumOptions={enumFixture}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByTestId("ai-suggestion-badge")).toBeNull();
  });

  it("calls onSelect with the row index when an enum row is clicked", () => {
    const onSelect = vi.fn();
    render(
      <SlashAutocomplete
        matches={[]}
        enumOptions={enumFixture}
        selectedIdx={0}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("enum-option-1"));
    expect(onSelect).toHaveBeenLastCalledWith(1);
  });

  it("deterministic slash matches win over enum options (defensive)", () => {
    render(
      <SlashAutocomplete
        matches={SLASH_DISPLAY.slice(0, 1)}
        enumOptions={enumFixture}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByTestId(`slash-suggestion-${SLASH_DISPLAY[0]!.command}`),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("enum-option-0")).toBeNull();
  });

  it("AI suggestions win over enum options (defensive)", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        suggestions={[
          { command: "/x", rationale: "y", confidence: 1 },
        ]}
        enumOptions={enumFixture}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("ai-suggestion-0")).toBeInTheDocument();
    expect(screen.queryByTestId("enum-option-0")).toBeNull();
  });
});

// ── Phase 4.5: visual polish (icons, highlight, footer) ────────────────────

describe("SlashAutocomplete — visual polish (Phase 4.5)", () => {
  it("renders an icon for each row keyed off the manifest category", () => {
    // /projects → query → Database icon (data-testid: row-icon-query).
    // /install  → action → Zap (data-testid: row-icon-action).
    // /settings → meta → Settings2 (data-testid: row-icon-meta).
    // /code     → nav → ArrowUpRight (data-testid: row-icon-nav).
    const sample = SLASH_DISPLAY.filter((e) =>
      ["projects", "install", "settings", "code"].includes(e.command),
    );
    render(
      <SlashAutocomplete
        matches={sample}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getAllByTestId("row-icon-query").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("row-icon-action").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("row-icon-meta").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("row-icon-nav").length).toBeGreaterThan(0);
  });

  it("highlights the matched substring in deterministic-mode labels", () => {
    // `/r` should bold the `r` in /radio / /resolve / /reopen labels.
    const sample = SLASH_DISPLAY.filter((e) => e.command.startsWith("r"));
    render(
      <SlashAutocomplete
        matches={sample}
        highlightQuery="r"
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    // The bolded char is rendered inside a <span> with the accent
    // color. Querying by accent color is brittle (CSS vars); instead
    // we walk the row label container and look for the inline-bold
    // span the highlighter produces.
    const radioRow = screen.getByTestId("slash-suggestion-radio");
    const bolded = radioRow.querySelectorAll("span[style*='font-weight: 600']");
    expect(bolded.length).toBeGreaterThan(0);
    // The bolded text inside the row is the `r` character.
    const found = Array.from(bolded).map((el) => el.textContent);
    expect(found).toContain("r");
  });

  it("does NOT highlight in AI mode (model-generated rows)", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        suggestions={[
          { command: "/projects --integration=capture", rationale: "ok", confidence: 1 },
        ]}
        // Even if the parent threaded a query through, the AI mode
        // explicitly passes "" — pinning the contract here.
        highlightQuery=""
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    const row = screen.getByTestId("ai-suggestion-0");
    const bolded = row.querySelectorAll("span[style*='font-weight: 600']");
    // The "AI" badge has fontWeight 600 too — count it AND assert no
    // *additional* bolded chars (i.e. only the badge contributes).
    expect(bolded).toHaveLength(1);
    expect(bolded[0]?.textContent).toBe("AI");
  });

  it("renders the keyboard-hint footer in slash mode", () => {
    render(
      <SlashAutocomplete
        matches={SLASH_DISPLAY.slice(0, 2)}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    const footer = screen.getByTestId("slash-autocomplete-footer");
    expect(footer.textContent ?? "").toContain("navigate");
    expect(footer.textContent ?? "").toContain("pick");
    expect(footer.textContent ?? "").toContain("dismiss");
  });

  it("renders the keyboard-hint footer in AI mode", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        suggestions={[
          { command: "/x", rationale: "y", confidence: 1 },
        ]}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("slash-autocomplete-footer")).toBeInTheDocument();
  });

  it("renders the keyboard-hint footer in enum mode", () => {
    render(
      <SlashAutocomplete
        matches={[]}
        enumOptions={["capture", "vercel"]}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("slash-autocomplete-footer")).toBeInTheDocument();
  });

  it("falls back to the neutral icon when the manifest has no category", () => {
    render(
      <SlashAutocomplete
        matches={[
          // Synthesized non-manifest entry — categoryOf returns undefined.
          { command: "notamanifestcommand", description: "fake" },
        ]}
        selectedIdx={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("row-icon-none")).toBeInTheDocument();
  });
});
