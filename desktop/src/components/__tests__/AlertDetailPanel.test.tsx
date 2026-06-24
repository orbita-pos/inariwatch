/**
 * AlertDetailPanel tests — cover the open/close store + the panel's
 * three top-level states (no-anchor / loading / loaded) without
 * exercising the full Tauri runtime. The cloud-ipc layer is mocked
 * with vi.hoisted so the mock IDs survive Vitest's module rewrite.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  AlertDetailPanel,
  useAlertDetailPanel,
} from "@/components/alert-detail-panel"
import type { AlertDetail, AlertTimeline } from "@/lib/cloud-ipc"
import { mttrLabel, relativeShort } from "@/components/alert-detail-panel/AlertLiveBanner"

const mocks = vi.hoisted(() => ({
  getDetail:   vi.fn<(id: string) => Promise<AlertDetail>>(),
  getTimeline: vi.fn<(id: string) => Promise<AlertTimeline>>(),
  ack:         vi.fn<(id: string) => Promise<{ ok: boolean }>>(),
  silence:     vi.fn<(id: string) => Promise<{ ok: boolean }>>(),
  resolve:     vi.fn<(args: { alertId?: string }) => Promise<{ ok: boolean }>>(),
}))

vi.mock("@/lib/cloud-ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cloud-ipc")>()
  return {
    ...actual,
    cloudGetAlertDetail:   mocks.getDetail,
    cloudGetAlertTimeline: mocks.getTimeline,
    cloudAckAlert:         mocks.ack,
    cloudSilenceAlert:     mocks.silence,
    cloudResolveAlert:     mocks.resolve,
  }
})

function makeAlert(over: Partial<AlertDetail> = {}): AlertDetail {
  return {
    id:                 "alert-1",
    title:              "AuthService 5xx spike",
    body:               "TypeError: Cannot read properties of undefined (reading 'sub')",
    severity:           "critical",
    sourceIntegrations: ["sentry"],
    fingerprint:        "abc123def456",
    isResolved:         false,
    resolvedAt:         null,
    isRead:             false,
    projectId:          "proj-1",
    projectName:        "Web App",
    projectSlug:        "web-app",
    createdAt:          "2026-05-13T20:00:00.000Z",
    lastEventAt:        "2026-05-13T20:14:00.000Z",
    ...over,
  }
}

function makeTimeline(over: Partial<AlertTimeline> = {}): AlertTimeline {
  return {
    events: [
      {
        id:    "fired:1",
        kind:  "alert_fired",
        at:    "2026-05-13T20:00:00.000Z",
        text:  "Alert fired · first event detected",
        actor: "system",
      },
      {
        id:      "rem-start:1",
        kind:    "remediation_started",
        at:      "2026-05-13T20:02:00.000Z",
        text:    "Inari started diagnosis",
        actor:   "Inari",
        witness: "w_rem_abc",
      },
    ],
    ...over,
  }
}

beforeEach(() => {
  mocks.getDetail.mockReset()
  mocks.getTimeline.mockReset()
  mocks.ack.mockReset()
  mocks.silence.mockReset()
  mocks.resolve.mockReset()
})

afterEach(() => {
  // Reset the store between tests so isOpen / anchorAlertId don't leak.
  // Using setState directly because the store doesn't expose a `reset`.
  useAlertDetailPanel.setState({ isOpen: false, anchorAlertId: null })
  if (typeof localStorage !== "undefined") localStorage.clear()
})

// ── Store ─────────────────────────────────────────────────────────────

describe("useAlertDetailPanel store", () => {
  it("toggles open/close and persists to localStorage", () => {
    const { toggle, isOpen: initial } = useAlertDetailPanel.getState()
    expect(initial).toBe(false)
    toggle()
    expect(useAlertDetailPanel.getState().isOpen).toBe(true)
    expect(localStorage.getItem("inari.alert-detail-panel.isOpen")).toBe("1")
    toggle()
    expect(useAlertDetailPanel.getState().isOpen).toBe(false)
    expect(localStorage.getItem("inari.alert-detail-panel.isOpen")).toBe("0")
  })

  it("open/close are idempotent (no state churn)", () => {
    const { open, close } = useAlertDetailPanel.getState()
    open()
    const after1 = useAlertDetailPanel.getState().isOpen
    open()
    expect(useAlertDetailPanel.getState().isOpen).toBe(after1)
    close()
    close()
    expect(useAlertDetailPanel.getState().isOpen).toBe(false)
  })

  it("setAnchor updates the alert id", () => {
    useAlertDetailPanel.getState().setAnchor("alert-x")
    expect(useAlertDetailPanel.getState().anchorAlertId).toBe("alert-x")
    useAlertDetailPanel.getState().setAnchor(null)
    expect(useAlertDetailPanel.getState().anchorAlertId).toBeNull()
  })
})

// ── Panel render ──────────────────────────────────────────────────────

describe("AlertDetailPanel", () => {
  it("renders no-anchor state when alertId is null", () => {
    render(<AlertDetailPanel alertId={null} onClose={() => {}} />)
    expect(screen.getByText(/open a conversation/i)).toBeTruthy()
  })

  it("fetches detail + timeline on mount and renders header + banner + timeline", async () => {
    mocks.getDetail.mockResolvedValueOnce(makeAlert())
    mocks.getTimeline.mockResolvedValueOnce(makeTimeline())
    render(<AlertDetailPanel alertId="alert-1" onClose={() => {}} />)

    await waitFor(() => expect(mocks.getDetail).toHaveBeenCalledWith("alert-1"))
    await waitFor(() => expect(mocks.getTimeline).toHaveBeenCalledWith("alert-1"))
    await waitFor(() => screen.getByText("AuthService 5xx spike"))

    expect(screen.getByText(/critical/i)).toBeTruthy()
    expect(screen.getByText(/still firing/i)).toBeTruthy()
    expect(screen.getByText(/inari started diagnosis/i)).toBeTruthy()
  })

  it("shows the resolved banner when isResolved=true", async () => {
    mocks.getDetail.mockResolvedValueOnce(
      makeAlert({
        isResolved: true,
        resolvedAt: "2026-05-13T20:15:00.000Z",
      }),
    )
    mocks.getTimeline.mockResolvedValueOnce(makeTimeline())
    render(<AlertDetailPanel alertId="alert-1" onClose={() => {}} />)

    await waitFor(() => screen.getByText(/resolved/i))
    // MTTR should appear: created 20:00, resolved 20:15 → 15m
    expect(screen.getByText(/mttr 15m/i)).toBeTruthy()
  })

  it("renders 'Postmortem actions' when resolved, 'Quick actions' when firing", async () => {
    mocks.getDetail.mockResolvedValueOnce(makeAlert({ isResolved: true, resolvedAt: "2026-05-13T20:15:00.000Z" }))
    mocks.getTimeline.mockResolvedValueOnce(makeTimeline())
    const { unmount } = render(<AlertDetailPanel alertId="alert-1" onClose={() => {}} />)
    await waitFor(() => screen.getByText(/postmortem actions/i))
    unmount()

    mocks.getDetail.mockResolvedValueOnce(makeAlert())
    mocks.getTimeline.mockResolvedValueOnce(makeTimeline())
    render(<AlertDetailPanel alertId="alert-2" onClose={() => {}} />)
    await waitFor(() => screen.getByText(/quick actions/i))
  })

  it("clicking Ack invokes cloudAckAlert and refetches timeline", async () => {
    mocks.getDetail.mockResolvedValueOnce(makeAlert())
    // First timeline fetch (mount) + second after Ack.
    mocks.getTimeline.mockResolvedValueOnce(makeTimeline())
    mocks.getTimeline.mockResolvedValueOnce(makeTimeline())
    mocks.ack.mockResolvedValueOnce({ ok: true })

    render(<AlertDetailPanel alertId="alert-1" onClose={() => {}} />)
    await waitFor(() => screen.getByText("AuthService 5xx spike"))

    const ackBtn = screen.getByRole("button", { name: /^ack$/i })
    await act(async () => {
      fireEvent.click(ackBtn)
    })
    await waitFor(() => expect(mocks.ack).toHaveBeenCalledWith("alert-1"))
    await waitFor(() => expect(mocks.getTimeline).toHaveBeenCalledTimes(2))
  })

  it("clicking the close button (X) fires onClose", async () => {
    mocks.getDetail.mockResolvedValueOnce(makeAlert())
    mocks.getTimeline.mockResolvedValueOnce(makeTimeline())
    const onClose = vi.fn()
    render(<AlertDetailPanel alertId="alert-1" onClose={onClose} />)
    await waitFor(() => screen.getByText("AuthService 5xx spike"))

    // Find the close button in the header (title "Close (⌘\)")
    const closeBtn = screen.getAllByRole("button", { name: /close panel/i })[0]
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalled()
  })

  it("surfaces fetch errors in an inline banner without closing the panel", async () => {
    mocks.getDetail.mockRejectedValueOnce("HTTP 500")
    mocks.getTimeline.mockResolvedValueOnce(makeTimeline())
    render(<AlertDetailPanel alertId="alert-1" onClose={() => {}} />)

    await waitFor(() => screen.getByText(/http 500/i))
    // The panel is still rendered — confirm by the close button presence.
    expect(screen.getAllByRole("button", { name: /close/i }).length).toBeGreaterThan(0)
  })
})

// ── Pure helpers ──────────────────────────────────────────────────────

describe("relativeShort", () => {
  it("returns 'just now' for very recent timestamps", () => {
    expect(relativeShort(new Date().toISOString())).toMatch(/just now/i)
  })
  it("formats seconds", () => {
    expect(relativeShort(new Date(Date.now() - 30_000).toISOString())).toBe("30s ago")
  })
  it("formats minutes", () => {
    expect(relativeShort(new Date(Date.now() - 300_000).toISOString())).toBe("5m ago")
  })
  it("formats hours", () => {
    expect(relativeShort(new Date(Date.now() - 7200_000).toISOString())).toBe("2h ago")
  })
  it("falls back gracefully on bad input", () => {
    expect(relativeShort("not-a-date")).toBe("—")
  })
})

describe("mttrLabel", () => {
  it("formats sub-minute as Xs", () => {
    expect(mttrLabel("2026-01-01T00:00:00Z", "2026-01-01T00:00:42Z")).toBe("42s")
  })
  it("formats sub-hour with seconds when present", () => {
    expect(mttrLabel("2026-01-01T00:00:00Z", "2026-01-01T00:08:42Z")).toBe("8m 42s")
  })
  it("formats sub-hour without seconds when round", () => {
    expect(mttrLabel("2026-01-01T00:00:00Z", "2026-01-01T00:15:00Z")).toBe("15m")
  })
  it("formats hours+minutes", () => {
    expect(mttrLabel("2026-01-01T00:00:00Z", "2026-01-01T02:30:00Z")).toBe("2h 30m")
  })
  it("returns null when resolved before created", () => {
    expect(mttrLabel("2026-01-01T00:10:00Z", "2026-01-01T00:00:00Z")).toBeNull()
  })
})
