/**
 * Inari Live Phase 5.1 — generic slot-picker shell.
 *
 * Floats below the dock input bar when the dispatcher receives a
 * `{kind: "suspended", needs, partial}` result. Renders a header that
 * shows the in-flight command + collected args + the slot prompt, a
 * dismiss button, and (for now) a placeholder body. Phase 5.2 onwards
 * swaps the placeholder for specialised pickers based on `spec.kind`.
 *
 * Visual language: the picker is a CARD (rounded border, distinct
 * surface tint) rather than a floating dropdown. That visually signals
 * "we are in a guided arg-collection flow", which is structurally
 * different from typeahead autocomplete. Same `--border-strong` /
 * `--bg-elev-1` tokens the rest of the dock uses; light + dark themes
 * inherit automatically.
 *
 * Keyboard: Esc cancels (dispatcher returns dock to idle). When a
 * specialized picker renders inside the slot, that picker handles its
 * own Tab/Arrow/Enter navigation. The shell only owns Esc + the close
 * button so cancel works uniformly across slot kinds.
 */
import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { ScopedMemory } from "@/lib/slash/scoped-memory";
import {
  describeCollected,
  type PartialCommand,
  type SlotSpec,
  type SlotValue,
} from "@/lib/slash/suspended-command";

import { AlertPickerSlot } from "./AlertPickerSlot";
import { ContactPickerSlot } from "./ContactPickerSlot";
import { PathPickerSlot } from "./PathPickerSlot";
import { ProjectLinkSlot } from "./ProjectLinkSlot";
import { ProjectPickerSlot } from "./ProjectPickerSlot";
import { TextSlotModal } from "./TextSlotModal";

export interface SlotPickerProps {
  /** In-flight command + already-collected args. */
  partial: PartialCommand;
  /** What this slot is asking for — header label + kind switch. */
  spec: SlotSpec;
  /**
   * User picked a value — caller resumes the command with the merged
   * args.
   */
  onPick: (value: SlotValue) => void;
  /** User dismissed — caller returns the dock to idle. */
  onCancel: () => void;
  /**
   * Phase 5.7 — scoped memory accessor. Pickers that benefit from
   * recently-mentioned entities (alert, project, path) read this to
   * promote rows to the top. Optional; pickers fall back to fresh
   * data when unset.
   */
  scopedMemory?: ScopedMemory;
}

/**
 * Build the picker header. Visual:
 *
 *   /whatsapp  Jose →  message?              [ ×  ]
 *   ──────── ────  ── ───────                ──────
 *   muted   subtle dim text                  cancel
 *
 * The `/cmd` slug stays subtle; collected args render in the body
 * tone; the slot prompt is the focal text. Mirrors how command-line
 * tools typeset breadcrumbs ("git switch → branch?").
 */
function PickerHeader({
  partial,
  spec,
  onCancel,
}: {
  partial: PartialCommand;
  spec: SlotSpec;
  onCancel: () => void;
}) {
  const collected = describeCollected(partial);
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="text-[13px] truncate" style={{ color: "var(--text)" }}>
        <span style={{ color: "var(--text-muted)" }}>/{partial.command}</span>
        {collected ? (
          <span style={{ color: "var(--text-subtle)" }}>{" "}{collected}</span>
        ) : null}
        <span style={{ color: "var(--text-faint)" }}>{" "}→{" "}</span>
        <span style={{ color: "var(--text)", fontWeight: 500 }}>
          {spec.prompt}
        </span>
      </div>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel"
        data-testid="slot-picker-cancel"
        className="rounded-md h-7 w-7 flex items-center justify-center transition-colors"
        style={{ color: "var(--text-subtle)" }}
      >
        <X size={14} strokeWidth={1.6} />
      </button>
    </div>
  );
}

/**
 * Placeholder body for slot kinds whose specialised picker hasn't
 * landed yet (5.6 path, 5.7 alert, 5.8 project). Tests assert against
 * `data-slot-kind` on the SlotPicker root, so kinds without a
 * specialised picker still satisfy the contract.
 */
function PlaceholderBody({ spec }: { spec: SlotSpec }) {
  return (
    <div
      className="text-[12px] py-3 px-2 rounded-md"
      style={{
        color: "var(--text-faint)",
        background: "var(--bg-elev-2, var(--surface))",
        textAlign: "center",
      }}
    >
      Slot picker for <code>{spec.kind}</code> — specialised component
      lands in Phase 5.6+.
    </div>
  );
}

/**
 * Per-kind body dispatch. Specialised pickers live in sibling files;
 * SlotPicker stays the layout shell. Adding a new kind: add a case +
 * specialised component. The exhaustive switch ensures TS catches
 * future SlotKind additions.
 */
function PickerBody({
  spec,
  onPick,
  scopedMemory,
}: {
  spec: SlotSpec;
  onPick: (value: SlotValue) => void;
  scopedMemory?: ScopedMemory;
}) {
  switch (spec.kind) {
    case "contact":
      return (
        <ContactPickerSlot
          spec={spec}
          onPick={onPick}
          scopedMemory={scopedMemory}
        />
      );
    case "text":
      return <TextSlotModal spec={spec} onPick={onPick} />;
    case "path":
      return <PathPickerSlot spec={spec} onPick={onPick} />;
    case "alert":
      return (
        <AlertPickerSlot
          spec={spec}
          onPick={onPick}
          scopedMemory={scopedMemory}
        />
      );
    case "project":
      return (
        <ProjectPickerSlot
          spec={spec}
          onPick={onPick}
          scopedMemory={scopedMemory}
        />
      );
    case "project_link":
      return <ProjectLinkSlot spec={spec} onPick={onPick} />;
  }
}

/**
 * Phase 5.1 shell. Esc cancels; click on the X cancels; specialised
 * pickers slot in via the `kind`-switch below as they land. The
 * container is a self-contained card — DockConversation hides the
 * autocomplete dropdown while it's visible so the two surfaces never
 * overlap.
 */
export function SlotPicker({
  partial,
  spec,
  onPick,
  onCancel,
  scopedMemory,
}: SlotPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Esc anywhere inside the picker dismisses. Bound at the root so a
  // specialized picker can override via stopPropagation (e.g. an
  // alert picker with a nested search input that wants Esc to clear
  // first, then dismiss on second press).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Focus the root on mount so Esc lands on the picker, not on
  // whatever was previously focused (which might dismiss something
  // else). `tabIndex={-1}` makes the div programmatically focusable
  // without entering the tab order.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  return (
    <div
      ref={rootRef}
      role="dialog"
      tabIndex={-1}
      aria-label={`${partial.command} — ${spec.prompt}`}
      data-testid="slot-picker"
      data-slot-kind={spec.kind}
      className="rounded-[12px] p-3 outline-none"
      style={{
        background: "var(--bg-elev-1, var(--surface))",
        border: "1px solid var(--border-strong)",
        boxShadow: "0 1px 0 rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.025)",
      }}
    >
      <PickerHeader partial={partial} spec={spec} onCancel={onCancel} />
      <PickerBody spec={spec} onPick={onPick} scopedMemory={scopedMemory} />
      {/*
       * Hidden helper button so unit tests can simulate a pick on
       * slot kinds whose specialised picker is still a placeholder
       * (5.6 path / 5.7 alert / 5.8 project before they ship). NOT
       * rendered visibly — `data-testid="slot-picker-pick-stub"` is
       * tied to `display: none` and serves the test surface only.
       * Removed in 5.6/5.7/5.8 when those pickers replace the
       * placeholder body.
       */}
      <button
        type="button"
        data-testid="slot-picker-pick-stub"
        onClick={() => onPick(defaultPickFor(spec))}
        style={{ display: "none" }}
        tabIndex={-1}
        aria-hidden
      />
    </div>
  );
}

/**
 * Test-only sentinel value. Specialised pickers replace this body
 * with their own selection UI; for unit-test cases that exercise the
 * shell's `onPick` plumbing, the hidden stub above dispatches this
 * default. NOT exported as part of the public API — kept module-local
 * so a future refactor can drop the hidden button without ripple.
 */
function defaultPickFor(spec: SlotSpec): SlotValue {
  switch (spec.kind) {
    case "contact":
      return { kind: "contact", jid: "+0000000000", name: "stub" };
    case "project":
      return { kind: "project", id: "stub", name: "stub" };
    case "alert":
      return { kind: "alert", id: "stub", hash: "stub", title: "stub" };
    case "path":
      return { kind: "path", value: "stub" };
    case "text":
      return { kind: "text", value: "stub" };
    case "project_link":
      return { kind: "project_link", projectId: "stub-project-id" };
  }
}
