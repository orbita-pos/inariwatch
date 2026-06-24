/**
 * Phase 5.5 — text-input slot.
 *
 * Renders a single-line textarea (auto-grows up to 4 rows). Enter
 * submits, Shift+Enter inserts a newline, Esc bubbles up to the
 * outer SlotPicker which cancels.
 *
 * Used for the "message body" slot in `/whatsapp <recipient> ?` and
 * future `/resolve <reason>` / `/silence <reason>` flows. The slot
 * spec's `placeholder` becomes the textarea's empty-state hint.
 */
import { ArrowUp } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { SlotSpec, SlotValue } from "@/lib/slash/suspended-command";

const MIN_ROWS = 1;
const MAX_ROWS = 4;

export interface TextSlotModalProps {
  spec: SlotSpec;
  onPick: (value: SlotValue) => void;
}

export function TextSlotModal({ spec, onPick }: TextSlotModalProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus on mount so the user can start typing without an extra
  // click. SlotPicker's keydown listener (Esc → cancel) is at the
  // root, so Esc still bubbles correctly while focus is here.
  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onPick({ kind: "text", value: trimmed });
  }, [onPick, value]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Auto-grow within MIN_ROWS..MAX_ROWS. The CSS `rows` attribute is
  // the floor; height is recomputed from the scrollHeight so multi-
  // line content stays visible without overflowing.
  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    const lineHeight = 18;
    const maxHeight = lineHeight * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  };

  const trimmedHasContent = value.trim().length > 0;

  return (
    <div data-testid="text-slot-modal">
      <div
        className="flex items-end gap-2 rounded-md p-2"
        style={{
          background: "var(--bg-elev-2, var(--surface))",
          border: "1px solid var(--border)",
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={onChange}
          onKeyDown={onKey}
          placeholder={spec.placeholder ?? "Type and press Enter…"}
          rows={MIN_ROWS}
          aria-label={spec.prompt}
          data-testid="text-slot-input"
          className="flex-1 bg-transparent text-[13px] outline-none border-none resize-none placeholder:tracking-[-0.005em]"
          style={{
            color: "var(--text)",
            lineHeight: "18px",
            letterSpacing: "-0.005em",
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!trimmedHasContent}
          aria-label="Submit"
          data-testid="text-slot-submit"
          className="h-7 w-7 rounded-md flex items-center justify-center transition-colors disabled:cursor-not-allowed"
          style={{
            color: trimmedHasContent ? "var(--text)" : "var(--text-faint)",
          }}
        >
          <ArrowUp size={14} strokeWidth={1.8} />
        </button>
      </div>
      <div
        className="mt-1.5 text-[10.5px] tracking-[0.04em]"
        style={{ color: "var(--text-faint)" }}
      >
        Enter to send · Shift+Enter for newline · Esc to cancel
      </div>
    </div>
  );
}
