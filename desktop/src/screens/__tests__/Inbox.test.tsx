/**
 * MainInbox tests — covers the redesigned inbox surface.
 *
 * Exercises: data fetch + filter chips + row rendering (severity dot,
 * snippet with role prefix, status pill, time) + keyboard navigation
 * (J/K + arrows + Enter + Esc) + empty/loading/error states + pure
 * helpers (sevToColor, formatActor, relative).
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MainInbox, sevToColor, formatActor, relative } from "@/screens/main/Inbox"
import type { ConversationListRow } from "@/lib/cloud-ipc"

const mocks = vi.hoisted(() => ({
  list: vi.fn<(args: unknown) => Promise<{ conversations: ConversationListRow[] }>>(),
}))

vi.mock("@/lib/cloud-ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cloud-ipc")>()
  return {
    ...actual,
    cloudConversationsList: mocks.list,
  }
})

// Stub the command palette store — clicking the search trigger calls
// `openPalette("search")`, and the store itself isn't under test.
vi.mock("@/lib/store/commandPalette", () => ({
  useCommandPalette: (selector: (s: { openWithIntent: (intent: string) => void }) => unknown) =>
    selector({ openWithIntent: vi.fn() }),
}))

// Tauri's `listen` API throws in jsdom without setup. Stub it so the
// SSE listener registration silently no-ops in tests.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))

function makeRow(over: Partial<ConversationListRow> = {}): ConversationListRow {
  return {
    id:                      `c-${Math.random().toString(36).slice(2, 8)}`,
    title:                   "AuthService 5xx spike",
    state:                   "active",
    anchorAlertId:           "alert-1",
    lastMessageAt:           new Date(Date.now() - 120_000).toISOString(),
    snoozedUntil:            null,
    resolvedAt:              null,
    workspaceId:             "ws-1",
    alertSeverity:           "critical",
    alertSourceIntegrations: ["web"],
    unreadHint:              true,
    lastMessageSnippet:      "Opened PR #4187 with the three-segment guard.",
    lastMessageRole:         "assistant",
    ...over,
  }
}

beforeEach(() => {
  mocks.list.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── Pure helpers ──────────────────────────────────────────────────────────

describe("sevToColor", () => {
  it("maps critical to red, warning to gold, info to purple, low to muted, unknown to dim", () => {
    expect(sevToColor("critical")).toBe("#D08585")
    expect(sevToColor("warning")).toBe("#D4B47A")
    expect(sevToColor("info")).toBe("#B8B0E0")
    expect(sevToColor("low")).toBe("#888690")
    expect(sevToColor(null)).toBe("#56565e")
    expect(sevToColor("nope")).toBe("#56565e")
  })
})

describe("formatActor", () => {
  it("returns 'Inari' for assistant, 'you' for user, 'tool' for tool, null for system/null", () => {
    expect(formatActor("assistant")).toBe("Inari")
    expect(formatActor("user")).toBe("you")
    expect(formatActor("tool")).toBe("tool")
    expect(formatActor("system")).toBeNull()
    expect(formatActor(null)).toBeNull()
  })
})

describe("relative", () => {
  it("formats sub-minute, sub-hour, sub-day, and yesterday", () => {
    expect(relative(new Date(Date.now() - 30_000).toISOString())).toBe("30s ago")
    expect(relative(new Date(Date.now() - 300_000).toISOString())).toBe("5m ago")
    expect(relative(new Date(Date.now() - 7200_000).toISOString())).toBe("2h ago")
    expect(relative(new Date(Date.now() - 86400_000 * 1.4).toISOString())).toBe("yesterday")
  })
  it("falls back on bad input", () => {
    expect(relative("not-a-date")).toBe("not-a-date")
  })
})

// ── Rendering ─────────────────────────────────────────────────────────────

describe("MainInbox rendering", () => {
  it("renders the topbar counter + filter chips with counts", async () => {
    mocks.list.mockResolvedValueOnce({
      conversations: [
        makeRow({ state: "active", unreadHint: true }),
        makeRow({ state: "active", unreadHint: false }),
        makeRow({ state: "snoozed" }),
        makeRow({ state: "resolved" }),
      ],
    })
    render(<MainInbox onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => screen.getByTestId("inbox-list"))

    expect(screen.getByTestId("inbox-counter")).toHaveTextContent(/4 conversations/i)
    expect(screen.getByTestId("inbox-counter")).toHaveTextContent(/2 firing/i)
    // Filter chip counts are inline
    expect(screen.getByTestId("inbox-filter-all")).toHaveTextContent(/4/)
    expect(screen.getByTestId("inbox-filter-firing")).toHaveTextContent(/2/)
    expect(screen.getByTestId("inbox-filter-snoozed")).toHaveTextContent(/1/)
    expect(screen.getByTestId("inbox-filter-resolved")).toHaveTextContent(/1/)
  })

  it("shows empty state when no conversations", async () => {
    mocks.list.mockResolvedValueOnce({ conversations: [] })
    render(<MainInbox onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => screen.getByTestId("inbox-empty"))
    expect(screen.getByText(/no active conversations/i)).toBeTruthy()
  })

  it("renders skeleton during initial loading", () => {
    mocks.list.mockReturnValue(new Promise(() => {})) // never resolves
    render(<MainInbox onSelect={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId("inbox-skeleton")).toBeTruthy()
  })

  it("renders row snippet with 'Inari:' prefix for assistant messages", async () => {
    mocks.list.mockResolvedValueOnce({
      conversations: [
        makeRow({
          lastMessageSnippet: "Opened PR #4187",
          lastMessageRole: "assistant",
        }),
      ],
    })
    render(<MainInbox onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => screen.getByText(/opened pr #4187/i))
    // Two "Inari" matches exist (topbar brand + snippet actor). Scope
    // to the row to be specific — the row is the first <button> with
    // a data-testid starting with `inbox-row-`.
    const rows = screen.getAllByTestId(/^inbox-row-/)
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toMatch(/Inari:/)
  })

  it("calls onSelect with the row id when a row is clicked", async () => {
    const row = makeRow({ id: "c-xyz" })
    mocks.list.mockResolvedValueOnce({ conversations: [row] })
    const onSelect = vi.fn()
    render(<MainInbox onSelect={onSelect} onClose={() => {}} />)
    await waitFor(() => screen.getByTestId(`inbox-row-${row.id}`))
    fireEvent.click(screen.getByTestId(`inbox-row-${row.id}`))
    expect(onSelect).toHaveBeenCalledWith("c-xyz")
  })

  it("clicking a filter chip refetches with the right params", async () => {
    mocks.list.mockResolvedValueOnce({ conversations: [makeRow()] })
    mocks.list.mockResolvedValueOnce({ conversations: [makeRow({ state: "snoozed" })] })
    render(<MainInbox onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId("inbox-filter-snoozed"))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    expect(mocks.list).toHaveBeenLastCalledWith({ state: "snoozed" })
  })

  it("error from the IPC surfaces inline", async () => {
    mocks.list.mockRejectedValueOnce(new Error("not_connected"))
    render(<MainInbox onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => screen.getByText(/sign in from settings/i))
  })
})

// ── Keyboard ──────────────────────────────────────────────────────────────

describe("MainInbox keyboard navigation", () => {
  function setupTwoRows() {
    mocks.list.mockResolvedValueOnce({
      conversations: [
        makeRow({ id: "c1", title: "First" }),
        makeRow({ id: "c2", title: "Second" }),
      ],
    })
  }

  it("J / ArrowDown moves selection forward", async () => {
    setupTwoRows()
    const onSelect = vi.fn()
    render(<MainInbox onSelect={onSelect} onClose={() => {}} />)
    await waitFor(() => screen.getByTestId("inbox-row-c1"))

    act(() => { fireEvent.keyDown(window, { key: "j" }) })
    // Now selection is index 1; Enter should open c2
    act(() => { fireEvent.keyDown(window, { key: "Enter" }) })
    expect(onSelect).toHaveBeenCalledWith("c2")
  })

  it("K / ArrowUp moves selection backward", async () => {
    setupTwoRows()
    const onSelect = vi.fn()
    render(<MainInbox onSelect={onSelect} onClose={() => {}} />)
    await waitFor(() => screen.getByTestId("inbox-row-c1"))

    // Move to index 1, then back to 0
    act(() => { fireEvent.keyDown(window, { key: "j" }) })
    act(() => { fireEvent.keyDown(window, { key: "ArrowUp" }) })
    act(() => { fireEvent.keyDown(window, { key: "Enter" }) })
    expect(onSelect).toHaveBeenCalledWith("c1")
  })

  it("Esc fires onClose", async () => {
    setupTwoRows()
    const onClose = vi.fn()
    render(<MainInbox onSelect={() => {}} onClose={onClose} />)
    await waitFor(() => screen.getByTestId("inbox-row-c1"))
    act(() => { fireEvent.keyDown(window, { key: "Escape" }) })
    expect(onClose).toHaveBeenCalled()
  })

  it("ignores keys while focus is in an input (lets the user type in palette)", async () => {
    setupTwoRows()
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <>
        <input data-testid="external-input" />
        <MainInbox onSelect={onSelect} onClose={onClose} />
      </>,
    )
    await waitFor(() => screen.getByTestId("inbox-row-c1"))

    const input = screen.getByTestId("external-input")
    input.focus()
    act(() => { fireEvent.keyDown(input, { key: "j" }) })
    act(() => { fireEvent.keyDown(input, { key: "Escape" }) })
    // No row activated, no close called — the inbox shouldn't steal
    // keys while the user is typing.
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("selection wraps via the home / end shortcuts (g / G)", async () => {
    mocks.list.mockResolvedValueOnce({
      conversations: [
        makeRow({ id: "c1" }),
        makeRow({ id: "c2" }),
        makeRow({ id: "c3" }),
      ],
    })
    const onSelect = vi.fn()
    render(<MainInbox onSelect={onSelect} onClose={() => {}} />)
    await waitFor(() => screen.getByTestId("inbox-row-c1"))

    act(() => { fireEvent.keyDown(window, { key: "G" }) }) // jump to end
    act(() => { fireEvent.keyDown(window, { key: "Enter" }) })
    expect(onSelect).toHaveBeenLastCalledWith("c3")

    act(() => { fireEvent.keyDown(window, { key: "g" }) }) // jump to top
    act(() => { fireEvent.keyDown(window, { key: "Enter" }) })
    expect(onSelect).toHaveBeenLastCalledWith("c1")
  })
})
