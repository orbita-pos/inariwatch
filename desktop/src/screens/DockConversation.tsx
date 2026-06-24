import { motion, useReducedMotion } from "framer-motion";
import { ArrowUp, Mic } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ChatMessage } from "@/components/ChatMessage";
import { SlotPicker } from "@/components/dock/slots/SlotPicker";
import {
  SlashAutocomplete,
  filterSlashMatches,
} from "@/components/SlashAutocomplete";
import { MicButton } from "@/components/voice/MicButton";
import { InariMark } from "@/screens/MainWindow";
import { cn } from "@/lib/cn";
import { SLASH_DISPLAY } from "@/lib/slash-catalog";
import { handleSlashSubmit, resumeSlashCommand } from "@/lib/slash-dispatch";
import {
  completeEnumValue,
  filterEnumValues,
  parseEnumContext,
} from "@/lib/slash/arg-parser";
import {
  suggestSlashCommands,
  type SlashSuggestion,
} from "@/lib/slash/suggest-ipc";
import {
  ScopedMemory,
  type MemoryEntry,
} from "@/lib/slash/scoped-memory";
import {
  mergeSlotValue,
  type SlotValue,
  type SuspendedState,
} from "@/lib/slash/suspended-command";
import { useChat } from "@/lib/store/chat";
import { useVoiceSettings } from "@/lib/store/voice";
import { synthesizeSpeech } from "@/lib/voice-ipc";

const SCROLL_BOTTOM_TOLERANCE = 16;

/**
 * How long the "Pick a suggestion or type / for commands" hint stays
 * visible after a no-op submit. 3500ms is roughly the time it takes
 * to read the line plus a beat — long enough that the user is sure
 * they saw it, short enough that it doesn't linger when they start
 * typing again.
 */
const SUBMIT_HINT_TIMEOUT_MS = 3500;
const SUBMIT_HINT = "Pick a suggestion or type / for commands.";

interface DockConversationProps {
  /**
   * Auto-focus the input on mount. True in production. Tests pass false
   * to avoid jsdom focus complaints.
   */
  autoFocusInput?: boolean;
}

/**
 * Chat surface — the only screen the user sees by default after the
 * 2026-05-07 chat-first reframe. Empty state (the command-palette
 * tip) and the populated thread share one layout: scrollable column
 * on top, input bar pinned at the bottom, both at `max-w-[760px]` so
 * reading width matches the design comp.
 *
 * Phase 3 of the pure-slash refactor (2026-05-15) turned the input
 * into a command bar: only slash commands dispatch on submit. Free
 * text falls through to the AI suggestion dropdown (Phase 2) for the
 * user to pick — never to free-chat-with-an-LLM. A no-op submit
 * surfaces a transient hint and bails.
 *
 * Action buttons (Apply fix / Show diff / Tell me more) used to live
 * in a sticky window-bottom footer; they now scroll INSIDE the
 * assistant turn that proposed the fix — `ChatMessage` renders the
 * inline action row when it detects a patch in the latest assistant
 * message. Window chrome stays calm. Those buttons currently dispatch
 * canned free-text prompts that no longer wire through to the LLM;
 * Phase 4 of the refactor either converts them to slash commands or
 * removes them outright.
 */
export function DockConversation({ autoFocusInput = true }: DockConversationProps) {
  const messages = useChat((s) => s.messages);
  const inputValue = useChat((s) => s.inputValue);
  const setInputValue = useChat((s) => s.setInputValue);
  const appendMessage = useChat((s) => s.appendMessage);
  const sessionId = useChat((s) => s.sessionId);

  const voiceSettings = useVoiceSettings((s) => s.settings);
  const voiceLoaded = useVoiceSettings((s) => s.loaded);
  const loadVoice = useVoiceSettings((s) => s.loadAll);
  useEffect(() => {
    if (!voiceLoaded) void loadVoice();
  }, [voiceLoaded, loadVoice]);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickyBottom, setStickyBottom] = useState(true);
  const reduce = useReducedMotion();
  const lastSpokenIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!stickyBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, stickyBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    setStickyBottom(distanceFromBottom <= SCROLL_BOTTOM_TOLERANCE);
  }, []);

  useEffect(() => {
    if (autoFocusInput) {
      inputRef.current?.focus();
    }
  }, [autoFocusInput]);

  useEffect(() => {
    if (!voiceSettings.output_enabled || !voiceSettings.auto_speak_responses) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    if (last.streaming) return;
    if (lastSpokenIdRef.current === last.id) return;
    if (!last.content || !last.content.trim()) return;
    lastSpokenIdRef.current = last.id;
    void speakText(last.content, voiceSettings.tts_voice || undefined);
  }, [messages, voiceSettings.auto_speak_responses, voiceSettings.output_enabled, voiceSettings.tts_voice]);

  const onTranscribed = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const next = inputValue ? `${inputValue} ${trimmed}` : trimmed;
      setInputValue(next);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [inputValue, setInputValue],
  );

  // Transient hint shown after a no-op submit (non-slash text without a
  // picked suggestion). Auto-clears after SUBMIT_HINT_TIMEOUT_MS so it
  // doesn't shadow the keybinding hint forever. Cleared earlier on the
  // next keystroke (see the input's onChange).
  const [submitHint, setSubmitHint] = useState<string | null>(null);
  const submitHintTimer = useRef<number | null>(null);
  const flashSubmitHint = useCallback((message: string) => {
    setSubmitHint(message);
    if (submitHintTimer.current !== null) {
      window.clearTimeout(submitHintTimer.current);
    }
    submitHintTimer.current = window.setTimeout(() => {
      setSubmitHint(null);
      submitHintTimer.current = null;
    }, SUBMIT_HINT_TIMEOUT_MS);
  }, []);
  useEffect(() => () => {
    if (submitHintTimer.current !== null) {
      window.clearTimeout(submitHintTimer.current);
    }
  }, []);

  // ── Phase 5.1 — SuspendedCommand state ───────────────────────────
  // When a pilot handler (Phase 5.5+) signals `suspended` via the
  // `onSuspended` hook on SlashCtx, we stash the SuspendedState here
  // and render `<SlotPicker>` below the input. Cancel returns to
  // null; pick re-dispatches via `resumeSlashCommand`. Only the
  // pilot commands set this — legacy handlers keep pushing inline
  // error notes via `appendMessage` (5.1 ships the infrastructure;
  // 5.5–5.8 opt in per command).
  const [activeSlot, setActiveSlot] = useState<SuspendedState | null>(null);

  // ── Phase 5.3 — Scoped memory ────────────────────────────────────
  // Lives in a ref (not state) so populating it doesn't trigger
  // re-renders — only the autocomplete prompt (5.4) and the slot
  // pickers (5.5+) read from it, and both already debounce/poll on
  // their own schedule. Capacity defaults to 3 (the Phase 5 plan).
  const scopedMemoryRef = useRef<ScopedMemory>(new ScopedMemory());
  const recordMemory = useCallback(
    (entry: Omit<MemoryEntry, "timestamp">) => {
      scopedMemoryRef.current.push(entry);
    },
    [],
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    // Slash commands intercept BEFORE the no-op path. The typing IS the
    // consent — slash bypasses Confirm but respects Deny. See
    // `lib/slash-dispatch.ts` for the orchestration.
    if (
      handleSlashSubmit(inputValue, {
        appendMessage,
        sessionId,
        onSuspended: (state) => setActiveSlot(state),
        recordMemory,
      })
    ) {
      setInputValue("");
      setStickyBottom(true);
      setSubmitHint(null);
      return;
    }
    // Phase 3 of the pure-slash refactor (2026-05-15): non-slash text
    // no longer falls through to free chat with the LLM. The user is
    // expected to either type a slash command directly, or pick one
    // from the AI autocomplete dropdown. If neither happens, surface
    // a hint and bail — never silently start a free-chat session.
    flashSubmitHint(SUBMIT_HINT);
  };

  /**
   * Phase 5.1 — picker callback: merge the picked value, re-dispatch
   * via `resumeSlashCommand`. If the underlying handler suspends
   * AGAIN (multi-slot flow), the `onSuspended` hook fires fresh and
   * `setActiveSlot` swaps to the next spec. The user never sees the
   * dock surface go idle between slots.
   */
  const onSlotPick = useCallback(
    async (value: SlotValue) => {
      if (!activeSlot) return;
      const merged = mergeSlotValue(
        activeSlot.partial,
        activeSlot.needs.name,
        value,
      );
      // Clear before dispatch so the next `onSuspended` (multi-slot)
      // installs the new state; a no-op resume returns the dock to
      // idle naturally.
      setActiveSlot(null);
      await resumeSlashCommand({
        partial: activeSlot.partial,
        spec: activeSlot.needs,
        mergedArgs: merged,
        rebuild: activeSlot.rebuild,
        ctx: {
          appendMessage,
          sessionId,
          onSuspended: (state) => setActiveSlot(state),
          recordMemory,
        },
      });
      setStickyBottom(true);
    },
    [activeSlot, appendMessage, sessionId, recordMemory],
  );

  /**
   * Phase 5.1 — picker cancel: drop the partial + return the dock to
   * idle. Per the plan, "Cancel == clean slate" — no half-filled
   * commands, no "would you like to save" prompts.
   */
  const onSlotCancel = useCallback(() => {
    setActiveSlot(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // ── Slash autocomplete state ─────────────────────────────────────
  // Three modes share one dropdown:
  //   - Deterministic: input starts with `/` and has no whitespace
  //     yet. Filter the catalog by prefix. NO AI call. Instant.
  //   - AI: input is non-empty and does NOT start with `/`. Debounced
  //     call to `suggest_slash_commands` returns the top-3 ranked
  //     completions, displayed with the model's rationale.
  //   - Arg-enum (Phase 4.1): input is `/<cmd> ... --flag=<partial>`
  //     where the manifest declares the flag's value type as enum.
  //     Filter `arg.enumValues` by the partial. NO AI call. Instant.
  // The three are mutually exclusive by construction — `slashMatches`
  // is empty when args are being typed, `aiSuggestions` is empty for
  // slash input, and the enum context only resolves for typed flags.
  // Esc dismisses any mode; the next keystroke re-opens it
  // (Slack/Discord-like).
  const slashMatches = useMemo(
    () => filterSlashMatches(inputValue, SLASH_DISPLAY),
    [inputValue],
  );

  const enumContext = useMemo(
    () => parseEnumContext(inputValue),
    [inputValue],
  );

  const enumOptions = useMemo(
    () => (enumContext ? filterEnumValues(enumContext) : []),
    [enumContext],
  );

  const [aiSuggestions, setAiSuggestions] = useState<readonly SlashSuggestion[]>(
    [],
  );
  const [aiLoading,  setAiLoading]  = useState(false);
  const [aiEmpty,    setAiEmpty]    = useState(false);

  const [slashIdx,        setSlashIdx]       = useState(0);
  const [slashDismissed,  setSlashDismissed] = useState(false);

  // Trim once for both the AI-eligibility check and the request body.
  const trimmedInput = inputValue.trim();
  // AI mode is eligible when the input is non-empty AND doesn't look
  // like a slash command. We also gate on length ≥ 2 to avoid firing
  // the LLM on every single keystroke — one char is rarely enough
  // signal for a useful suggestion and burns budget.
  const aiModeEligible =
    trimmedInput.length >= 2 && !trimmedInput.startsWith("/");

  const slashOpen = slashMatches.length > 0 && !slashDismissed;
  const enumOpen  =
    !slashDismissed && enumContext !== null && enumOptions.length > 0;
  const aiOpen    =
    !slashDismissed &&
    aiModeEligible &&
    (aiSuggestions.length > 0 || aiLoading || aiEmpty);

  // Each keystroke "tries again" with the autocomplete — reset highlight
  // to top + un-dismiss. Esc sets dismissed=true; the next keystroke
  // re-opens it. Completion (`completeSlash` / `completeAi`) also flows
  // through here because it sets inputValue.
  useEffect(() => {
    setSlashIdx(0);
    setSlashDismissed(false);
  }, [inputValue]);

  // ── AI suggestion debounce (300ms) ───────────────────────────────
  // Cancels in-flight requests when the input changes, so the dropdown
  // never shows suggestions for an earlier query. The `cancelled` flag
  // is the canonical React effect-cancellation pattern.
  useEffect(() => {
    if (!aiModeEligible) {
      // Slash mode (or empty input) — clear any prior AI state so the
      // dropdown switches cleanly between modes.
      setAiSuggestions([]);
      setAiLoading(false);
      setAiEmpty(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setAiLoading(true);
      setAiEmpty(false);
      // Phase 5.4 — feed the LLM the last 3 outputs as context so it
      // can resolve free-form references like "fixea la del payment".
      // Empty buffer → empty string → wire payload skips the field.
      const memoryContext = scopedMemoryRef.current.toAutocompletePromptContext();
      void suggestSlashCommands(trimmedInput, { memoryContext }).then(
        (results) => {
          if (cancelled) return;
          setAiSuggestions(results);
          setAiLoading(false);
          setAiEmpty(results.length === 0);
        },
      );
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmedInput, aiModeEligible]);

  const completeSlash = useCallback(
    (idx: number) => {
      const entry = slashMatches[idx];
      if (!entry) return;
      setInputValue(`/${entry.command} `);
      // Re-focus input so user can keep typing args without a click.
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [slashMatches, setInputValue],
  );

  const completeAi = useCallback(
    (idx: number) => {
      const entry = aiSuggestions[idx];
      if (!entry) return;
      // AI suggestions land in the input AS-IS — the user hits Enter
      // again to dispatch. This gives them a chance to edit args before
      // the command runs (key UX in the pure-slash plan: AI is a
      // scout, not an agent).
      setInputValue(entry.command);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [aiSuggestions, setInputValue],
  );

  const completeEnum = useCallback(
    (idx: number) => {
      if (!enumContext) return;
      const value = enumOptions[idx];
      if (value === undefined) return;
      // Splice the picked value in (and append a trailing space) so the
      // user can keep typing the next arg without an extra keystroke.
      setInputValue(completeEnumValue(inputValue, enumContext, value));
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [enumContext, enumOptions, inputValue, setInputValue],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, slashMatches.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Tab" || e.key === "Enter") {
        // Tab and Enter both complete; preventDefault on Enter
        // suppresses the form submit so the user can type args next.
        e.preventDefault();
        completeSlash(slashIdx);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
      }
      return;
    }
    if (enumOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, enumOptions.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Tab" || e.key === "Enter") {
        // Tab and Enter both complete; preventDefault on Enter
        // suppresses the form submit so the user stays in the arg
        // editor after picking a value.
        e.preventDefault();
        completeEnum(slashIdx);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
      }
      return;
    }
    if (aiOpen && aiSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, aiSuggestions.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        // Replace the input with the picked suggestion and STOP the
        // form submit — Phase 2 plan: the user hits Enter a second
        // time to actually dispatch. The first Enter is the autocomplete
        // pick.
        e.preventDefault();
        completeAi(slashIdx);
      } else if (e.key === "Tab") {
        e.preventDefault();
        completeAi(slashIdx);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
      }
      return;
    }
    if (aiOpen && e.key === "Escape") {
      // AI mode in loading / empty state — Esc dismisses anyway so
      // the user can type a slash command without the placeholder
      // hovering above the input.
      e.preventDefault();
      setSlashDismissed(true);
    }
  };

  const isEmpty = messages.length === 0;
  const lastAssistantId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "assistant") return m.id;
    }
    return null;
  })();

  return (
    <div data-testid="dock-conversation" className="flex flex-col h-full relative">
      {/* Body — empty state or thread. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="dock-conversation-scroll"
        className="flex-1 min-h-0 overflow-auto relative"
      >
        {/* Top scroll-fade — `pointer-events-none` so it never blocks
         * clicks. Matches the design comp's State 2/3/4 frames. The
         * BOTTOM fade was removed (2026-05-07): with auto-scroll-to-
         * bottom anchored, the most-recent assistant prose lives at
         * the bottom of the scroll area, and a fade there masked real
         * content rather than "hinting at overflow". The input bar
         * itself is the visual delimiter. */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-12 z-10 pointer-events-none"
          style={{
            background:
              "linear-gradient(180deg, var(--bg) 0%, var(--bg) 30%, rgba(10,10,12,0) 100%)",
          }}
        />

        {isEmpty ? (
          <EmptyWelcome reduce={reduce} />
        ) : (
          <div className="px-8 pt-10 pb-10 max-w-[760px] mx-auto">
            <ul className="flex flex-col">
              {messages.map((message) => (
                <li key={message.id} className="mb-7 last:mb-2">
                  <ChatMessage
                    message={message}
                    isLatestAssistant={message.id === lastAssistantId}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Phase 5.1 — SuspendedCommand slot picker.
       *   Renders above the input bar when a pilot command (5.5+)
       *   signals it needs an arg. The picker takes over the
       *   guided-arg flow; the autocomplete dropdown is hidden
       *   below by feeding empty arrays into `<SlashAutocomplete>`.
       *   Container shares the dock's 760px width so the visual
       *   column stays consistent with the rest of the surface.
       */}
      {activeSlot !== null ? (
        <div
          className="px-8 pb-2 pt-1 relative z-20"
          data-testid="dock-conversation-slot-host"
        >
          <div className="max-w-[760px] mx-auto">
            <SlotPicker
              partial={activeSlot.partial}
              spec={activeSlot.needs}
              onPick={onSlotPick}
              onCancel={onSlotCancel}
              scopedMemory={scopedMemoryRef.current}
            />
          </div>
        </div>
      ) : null}

      {/* Input bar — pinned to bottom, max-w-[760px] centered. */}
      <div className="px-8 pb-6 pt-3 relative z-20">
        <form
          onSubmit={onSubmit}
          className={cn(
            "flex items-center gap-1 max-w-[760px] mx-auto relative",
            "rounded-[12px] pl-4 pr-2",
          )}
          style={{
            height: 52,
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.028), rgba(255,255,255,0.01))",
            border: "1px solid var(--border-strong)",
            boxShadow:
              "0 1px 0 rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.025)",
          }}
        >
          {/* When a slot is active the picker owns the input flow —
           * suppress the autocomplete dropdown so the two surfaces
           * never overlap. The input itself stays visible (and
           * editable) so the user can still type a NEW slash
           * command if they cancel out of the picker. */}
          <SlashAutocomplete
            matches={!activeSlot && slashOpen ? slashMatches : []}
            suggestions={
              !activeSlot && !slashOpen && !enumOpen && aiOpen ? aiSuggestions : []
            }
            aiLoading={!activeSlot && !slashOpen && !enumOpen && aiOpen ? aiLoading : false}
            aiEmpty={!activeSlot && !slashOpen && !enumOpen && aiOpen ? aiEmpty : false}
            enumOptions={!activeSlot && enumOpen ? enumOptions : []}
            enumHeader={
              !activeSlot && enumOpen ? (enumContext?.arg.flag ?? enumContext?.arg.name) : undefined
            }
            // Phase 4.5 — highlight what the user typed in each row's
            // label. Slash mode passes the prefix sans leading slash;
            // enum mode passes the partial value typed after the `=`.
            // AI mode passes the empty string (model-generated commands
            // don't literally contain the user query).
            highlightQuery={
              slashOpen
                ? trimmedInput.slice(1)
                : enumOpen
                ? enumContext?.partial ?? ""
                : ""
            }
            selectedIdx={slashIdx}
            onSelect={
              slashOpen
                ? completeSlash
                : enumOpen
                ? completeEnum
                : completeAi
            }
          />
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              if (submitHint !== null) setSubmitHint(null);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Type / for commands or describe what you need"
            aria-label="Inari prompt"
            data-testid="dock-conversation-input"
            role="combobox"
            aria-expanded={slashOpen || enumOpen || aiOpen}
            aria-controls="slash-autocomplete"
            aria-activedescendant={
              slashOpen
                ? `slash-suggestion-${slashMatches[slashIdx]?.command}`
                : enumOpen
                ? `enum-option-${slashIdx}`
                : aiOpen && aiSuggestions.length > 0
                ? `ai-suggestion-${slashIdx}`
                : undefined
            }
            className="flex-1 h-full bg-transparent text-[14px] outline-none border-none placeholder:tracking-[-0.005em]"
            style={{
              color: "var(--text)",
              letterSpacing: "-0.005em",
            }}
          />
          {voiceSettings.input_enabled ? (
            <MicButton
              pushToTalk={voiceSettings.push_to_talk}
              onTranscribed={onTranscribed}
            />
          ) : (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Voice input disabled"
              className="h-9 w-9 rounded-lg flex items-center justify-center"
              style={{ color: "var(--text-faint)" }}
              disabled
            >
              <Mic size={16} strokeWidth={1.6} />
            </button>
          )}
          <button
            type="submit"
            aria-label="Send"
            disabled={!inputValue.trim()}
            data-testid="dock-conversation-send"
            className="h-9 w-9 rounded-lg flex items-center justify-center transition-colors disabled:cursor-not-allowed"
            style={{
              color: inputValue.trim() ? "var(--text)" : "var(--text-faint)",
            }}
          >
            <ArrowUp size={14} strokeWidth={1.8} />
          </button>
        </form>

        {submitHint !== null ? (
          <div
            data-testid="dock-conversation-submit-hint"
            role="status"
            aria-live="polite"
            className="text-center mt-2.5 tracking-[0.04em]"
            style={{ color: "var(--text-subtle)", fontSize: 10.5 }}
          >
            {submitHint}
          </div>
        ) : isEmpty ? (
          <div
            className="text-center mt-2.5 tracking-[0.04em]"
            style={{ color: "var(--text-faint)", fontSize: 10.5 }}
          >
            ⌘K to command · ⌘/ to view audit log · Witness receipts:{" "}
            <span style={{ color: "var(--text-dim)" }}>on</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface EmptyWelcomeProps {
  reduce: boolean | null;
}

/**
 * Phase 3 of the pure-slash refactor (2026-05-15) replaced the
 * "Ask Inari…" framing + three free-text Try prompts with a
 * command-palette pitch. The Try line now points at concrete slash
 * commands instead of natural-language prompts that used to dispatch
 * straight to the LLM; "describe what you want" steers users to the
 * autocomplete dropdown where the LLM translates intent → slash.
 */
function EmptyWelcome({ reduce }: EmptyWelcomeProps) {
  const exampleCommand = (text: string) => (
    <span
      className="font-mono"
      style={{ color: "var(--text-muted)" }}
    >
      {text}
    </span>
  );
  return (
    <div
      data-testid="dock-conversation-empty"
      className="h-full flex flex-col items-center justify-center text-center pt-10 pb-12"
    >
      <motion.div
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="mb-7"
      >
        <InariMark size={34} />
      </motion.div>
      <h2
        className="text-[24px] font-light tracking-[-0.022em] max-w-[560px]"
        style={{ color: "var(--text)" }}
      >
        Inari is your InariWatch command palette.
      </h2>
      <p
        className="text-[14px] mt-3 tracking-[-0.005em] max-w-[560px]"
        style={{ color: "var(--text-subtle)" }}
      >
        Try {exampleCommand("/projects")}
        {"   "}
        {exampleCommand("/alerts")}
        {"   "}
        {exampleCommand("/install <path>")}
      </p>
      <p
        className="text-[13px] mt-1.5 tracking-[-0.005em] max-w-[560px]"
        style={{ color: "var(--text-faint)" }}
      >
        Or describe what you want and pick a suggestion.
      </p>
    </div>
  );
}

async function speakText(text: string, voiceId?: string): Promise<void> {
  try {
    const result = await synthesizeSpeech(text, voiceId, 1.0);
    const bin = atob(result.audio_wav_b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const blob = new Blob([buf], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.addEventListener("ended", () => URL.revokeObjectURL(url));
    await audio.play();
  } catch {
    // Voice playback is best-effort — surface failures via tracing
    // (server-side) rather than blocking the chat surface.
  }
}
