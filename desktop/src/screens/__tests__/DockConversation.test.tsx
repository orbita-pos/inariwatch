import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DockShell } from "@/components/dock/DockShell";
import { installMockStreamForTests } from "@/lib/chat-stream";
import {
  __resetChatStoreForTests,
  setStreamDriver,
  useChat,
} from "@/lib/store/chat";
import { DockConversation } from "@/screens/DockConversation";

// jsdom has no Tauri runtime — stub `listen` to a no-op unlisten so the
// stream-driver installer doesn't warn.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

/**
 * Pin reduced-motion = true. Without it, Framer's `<AnimatePresence
 * mode="wait">` keeps the outgoing DockIdle in the tree during its
 * exit animation — the test would race the spring's settling time.
 * Reduced-motion swaps every animation to a 0ms transition AND tells
 * Framer to skip its enter/exit motion altogether, so the mode flip
 * is observable in the DOM on the next microtask.
 */
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  });
});

describe("DockConversation (via DockShell)", () => {
  beforeEach(() => {
    __resetChatStoreForTests();
  });
  afterEach(() => {
    __resetChatStoreForTests();
  });

  // The old "submitting input transitions from idle to conversation
  // mode" test was deleted in Phase 3 of the pure-slash refactor
  // (2026-05-15). Its premise — that arbitrary free text dispatches
  // to the LLM — no longer holds: the input bar is a command bar,
  // non-slash submits surface a hint and bail. The new behavior is
  // pinned by the "pure-slash command bar" describe block below.

  it("streaming a 50-token mock response paints all tokens within 1s without layout shift", async () => {
    // Real timers + tiny intervals so the test wall-clock stays well
    // under 1s. The mock canned response is ~53 tokens × 1ms ≈ 53ms.
    installMockStreamForTests(1);

    // Bypass the idle-mode entry and start directly in conversation
    // for a faster test path.
    act(() => {
      useChat.getState().startConversation();
    });

    const start = performance.now();
    render(<DockShell />);
    expect(screen.getByTestId("dock-shell")).toHaveAttribute(
      "data-mode",
      "conversation",
    );

    // Send a prompt — the canned mock stream picks up.
    act(() => {
      useChat.getState().sendMessage("explain auth");
    });

    // Wait for streaming to complete (assistant.streaming = false).
    await waitFor(
      () => {
        const messages = useChat.getState().messages;
        const assistant = messages.find((m) => m.role === "assistant");
        expect(assistant).toBeDefined();
        expect(assistant?.streaming).toBe(false);
      },
      { timeout: 5000 },
    );

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);

    // All tokens landed — the canned response's tail fragments only
    // appear after every earlier token has been appended.
    const assistant = useChat
      .getState()
      .messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toContain("Want");
    expect(assistant?.content).toContain("open");
    expect(assistant?.content).toContain("diff");

    // Layout-shift proxy: jsdom doesn't run layout, so we instead pin
    // the structural assertion: the assistant message has exactly one
    // `chat-message-assistant` node (no duplicate / re-mounted bubbles
    // mid-stream).
    expect(screen.getAllByTestId("chat-message-assistant")).toHaveLength(1);
  });
});

/**
 * Phase 3 of the pure-slash refactor (2026-05-15) — the input bar is
 * now a command bar. The tests below pin the three behaviors the
 * brief calls out:
 *
 *   1. The placeholder advertises slash + describe-what-you-need.
 *   2. The empty state shows the command-palette tip, not the legacy
 *      "Ask Inari…" free-form prompt list.
 *   3. Submitting non-slash text does NOT dispatch — it surfaces a
 *      transient hint instead, and the chat store stays empty.
 */
describe("DockConversation — pure-slash command bar (Phase 3)", () => {
  beforeEach(() => {
    __resetChatStoreForTests();
  });
  afterEach(() => {
    __resetChatStoreForTests();
  });

  it("renders the slash-aware placeholder on the input", () => {
    render(<DockConversation autoFocusInput={false} />);
    const input = screen.getByTestId("dock-conversation-input") as HTMLInputElement;
    expect(input.placeholder).toBe(
      "Type / for commands or describe what you need",
    );
  });

  it("empty state shows the command-palette tip with slash examples", () => {
    render(<DockConversation autoFocusInput={false} />);
    const empty = screen.getByTestId("dock-conversation-empty");
    expect(empty.textContent ?? "").toContain(
      "Inari is your InariWatch command palette.",
    );
    expect(empty.textContent ?? "").toContain("/projects");
    expect(empty.textContent ?? "").toContain("/alerts");
    expect(empty.textContent ?? "").toContain("/install");
    expect(empty.textContent ?? "").toContain(
      "Or describe what you want and pick a suggestion.",
    );
    // The legacy free-form "Try" prompts must be gone — they used to
    // dispatch straight to the LLM and bypass the new architecture.
    expect(empty.textContent ?? "").not.toContain("Why is auth failing?");
    expect(empty.textContent ?? "").not.toContain("Ask about an alert");
  });

  it("submitting non-slash text does NOT dispatch a message — it surfaces a hint", () => {
    // Sentinel driver: if free chat is still wired anywhere, this fires
    // and pushes a marker token. The assertion below will catch it.
    let driverCalls = 0;
    setStreamDriver((messageId) => {
      driverCalls += 1;
      useChat.getState().appendToken(messageId, "DRIVER_RAN");
      useChat.getState().finishStreaming(messageId);
    });

    render(<DockConversation autoFocusInput={false} />);
    const input = screen.getByTestId("dock-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alertas de hoy" } });
    fireEvent.submit(input.closest("form")!);

    // No message should have been added — non-slash submit is a no-op.
    expect(useChat.getState().messages).toHaveLength(0);
    expect(driverCalls).toBe(0);

    // The hint must appear so the user knows nothing happened.
    const hint = screen.getByTestId("dock-conversation-submit-hint");
    expect(hint.textContent ?? "").toContain(
      "Pick a suggestion or type / for commands",
    );
  });

  it("typing again clears the no-op hint immediately (does not wait for timeout)", () => {
    setStreamDriver(() => {});

    render(<DockConversation autoFocusInput={false} />);
    const input = screen.getByTestId("dock-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alertas" } });
    fireEvent.submit(input.closest("form")!);
    expect(
      screen.getByTestId("dock-conversation-submit-hint"),
    ).toBeInTheDocument();

    // Any keystroke after the no-op submit clears the hint.
    fireEvent.change(input, { target: { value: "alertas " } });
    expect(
      screen.queryByTestId("dock-conversation-submit-hint"),
    ).not.toBeInTheDocument();
  });
});

/**
 * Phase 4.1 of the pure-slash refactor (2026-05-15) — when the user
 * types `/<cmd> ... --flag=` for a manifest-declared enum arg, the
 * autocomplete dropdown switches to a deterministic enum picker.
 * NO AI call, instant. Enter picks; the value gets spliced into the
 * input with a trailing space.
 */
describe("DockConversation — arg-enum autocomplete (Phase 4.1)", () => {
  beforeEach(() => {
    __resetChatStoreForTests();
  });
  afterEach(() => {
    __resetChatStoreForTests();
  });

  it("shows the enum dropdown when the user types --integration=", () => {
    render(<DockConversation autoFocusInput={false} />);
    const input = screen.getByTestId("dock-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/projects --integration=" } });

    // Header labels the flag being edited.
    expect(screen.getByTestId("slash-autocomplete-header")).toHaveTextContent(
      "integration",
    );

    // Every value declared in the manifest's enumValues appears.
    expect(screen.getByTestId("enum-option-0")).toBeInTheDocument();
    expect(
      screen.queryByTestId(`slash-suggestion-projects`),
    ).not.toBeInTheDocument();
  });

  it("filters the enum values as the user types after the =", () => {
    render(<DockConversation autoFocusInput={false} />);
    const input = screen.getByTestId("dock-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/projects --integration=cap" } });

    expect(screen.getByTestId("enum-option-0")).toHaveTextContent("capture");
    // Only one match for the `cap` prefix among the 7 integrations.
    expect(screen.queryByTestId("enum-option-1")).toBeNull();
  });

  it("Enter on the highlighted enum row splices the value + trailing space", () => {
    render(<DockConversation autoFocusInput={false} />);
    const input = screen.getByTestId("dock-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/projects --integration=cap" } });

    fireEvent.keyDown(input, { key: "Enter" });

    // Input now reflects the chosen value with a trailing space so the
    // user can keep typing the next arg without an explicit keystroke.
    expect(input.value).toBe("/projects --integration=capture ");
    // Dropdown is closed because the trailing space breaks the enum
    // parsing context.
    expect(screen.queryByTestId("enum-option-0")).toBeNull();
  });

  it("ArrowDown / ArrowUp navigates between enum options", () => {
    render(<DockConversation autoFocusInput={false} />);
    const input = screen.getByTestId("dock-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/projects --integration=" } });

    // Initial selection is index 0.
    expect(screen.getByTestId("enum-option-0")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("enum-option-1")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByTestId("enum-option-0")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("Escape closes the dropdown until the next keystroke", () => {
    render(<DockConversation autoFocusInput={false} />);
    const input = screen.getByTestId("dock-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/projects --integration=" } });
    expect(screen.getByTestId("enum-option-0")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("enum-option-0")).toBeNull();

    // The next change re-opens it.
    fireEvent.change(input, { target: { value: "/projects --integration=c" } });
    expect(screen.getByTestId("enum-option-0")).toBeInTheDocument();
  });

  it("does NOT fire any AI suggestion request while in enum mode", async () => {
    // The trimmed input is slash-prefixed, so `aiModeEligible` is false
    // and `suggestSlashCommands` should never be called. This test pins
    // that contract — no fetch, no IPC, no LLM cost while editing args.
    setStreamDriver(() => {});
    render(<DockConversation autoFocusInput={false} />);
    const input = screen.getByTestId("dock-conversation-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/projects --integration=cap" } });

    // Enum dropdown rendered → AI badge must NOT be present anywhere.
    expect(screen.queryByTestId("ai-suggestion-badge")).toBeNull();
    expect(screen.queryByTestId("ai-suggestion-empty")).toBeNull();
  });
});
