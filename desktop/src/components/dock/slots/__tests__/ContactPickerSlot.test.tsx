/**
 * Phase 5.5 — ContactPickerSlot tests.
 *
 * Covers:
 *   1. Loading → loaded transition (contacts === null vs []).
 *   2. Empty paired list → "+ Pair new" CTA visible as primary action.
 *   3. Non-empty list → rows render with name + redacted number.
 *   4. Search filter is case-insensitive substring on name.
 *   5. Arrow keys move highlight; Enter picks the highlighted row.
 *   6. Click on a row dispatches onPick with the right value.
 *   7. + Pair new fires the injected onAddNew (legacy escape hatch).
 *   8. Phase 5.5 completion — when no `onAddNew` override, "+ Pair
 *      new" opens the inline WhatsApp pair flow; `onPaired` resumes
 *      the slash command with the freshly paired contact; `onClose`
 *      leaves the picker mounted without dispatching a pick.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ContactPickerSlot,
  contactsFromMemory,
  mergeContactSources,
  redactedFromJid,
  type PairFlowComponentProps,
} from "../ContactPickerSlot";
import type { ContactEntity } from "@/lib/slash/entities/types";
import { ScopedMemory } from "@/lib/slash/scoped-memory";
import type { SlotSpec } from "@/lib/slash/suspended-command";
import type { WhatsAppAccountInfo } from "@/lib/whatsapp-accounts";

/** A connected Baileys account stub, suitable for the listAccounts injection. */
function connectedAccount(
  over: Partial<WhatsAppAccountInfo> = {},
): WhatsAppAccountInfo {
  return {
    account_id: "acc-1",
    label: "Personal",
    self_jid: "5215511112222@s.whatsapp.net",
    status: "connected",
    last_qr_at_ms: null,
    last_linked_at_ms: Date.now(),
    ...over,
  };
}

function accountsFactory(rows: WhatsAppAccountInfo[]) {
  return vi.fn(async () => rows);
}

const spec: SlotSpec = {
  kind: "contact",
  name: "recipient",
  prompt: "who?",
};

const contact = (over: Partial<ContactEntity> = {}): ContactEntity => ({
  jid: "+5215512345678",
  name: "Jose",
  redacted: "+52 ••••5678",
  ...over,
});

function listFactory(contacts: ContactEntity[]) {
  return vi.fn(async () => contacts);
}

describe("<ContactPickerSlot>", () => {
  it("shows the loading state until the IPC resolves", async () => {
    // Promise that never resolves — we only assert the loading frame.
    const list = vi.fn(() => new Promise<ContactEntity[]>(() => {}));
    render(
      <ContactPickerSlot spec={spec} onPick={vi.fn()} list={list} />,
    );
    expect(screen.getByTestId("contact-picker-loading")).toBeTruthy();
  });

  it("renders the empty state + '+ Pair new' CTA when no contacts paired", async () => {
    const list = listFactory([]);
    const onAddNew = vi.fn();
    render(
      <ContactPickerSlot
        spec={spec}
        onPick={vi.fn()}
        list={list}
        onAddNew={onAddNew}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("contact-picker-empty")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("contact-picker-add-new"));
    expect(onAddNew).toHaveBeenCalledTimes(1);
  });

  it("renders contact rows with name + redacted form", async () => {
    const list = listFactory([
      contact({ name: "Jose", redacted: "+52 ••••5678" }),
      contact({ name: "Mom", jid: "+1234567890", redacted: "+1 ••••7890" }),
    ]);
    render(<ContactPickerSlot spec={spec} onPick={vi.fn()} list={list} />);
    await waitFor(() => {
      const rows = screen.getAllByTestId("contact-picker-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.textContent).toContain("Jose");
      expect(rows[0]!.textContent).toContain("+52 ••••5678");
      expect(rows[1]!.textContent).toContain("Mom");
    });
  });

  it("filters by case-insensitive substring on the display name", async () => {
    const list = listFactory([
      contact({ name: "Jose", jid: "+1", redacted: "+1 ••••" }),
      contact({ name: "Mom", jid: "+2", redacted: "+2 ••••" }),
      contact({ name: "Monica", jid: "+3", redacted: "+3 ••••" }),
    ]);
    render(<ContactPickerSlot spec={spec} onPick={vi.fn()} list={list} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("contact-picker-row")).toHaveLength(3);
    });
    fireEvent.change(screen.getByTestId("contact-picker-search"), {
      target: { value: "mo" },
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId("contact-picker-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.textContent).toContain("Mom");
      expect(rows[1]!.textContent).toContain("Monica");
    });
  });

  it("Enter picks the highlighted row (initially row 0)", async () => {
    const list = listFactory([
      contact({ name: "Jose", jid: "+1", redacted: "+1 ••••" }),
      contact({ name: "Mom", jid: "+2", redacted: "+2 ••••" }),
    ]);
    const onPick = vi.fn();
    render(<ContactPickerSlot spec={spec} onPick={onPick} list={list} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("contact-picker-row")).toHaveLength(2);
    });
    const input = screen.getByTestId("contact-picker-search");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({
      kind: "contact",
      jid: "+1",
      name: "Jose",
    });
  });

  it("Arrow keys move the highlight; Enter picks the new row", async () => {
    const list = listFactory([
      contact({ name: "Jose", jid: "+1", redacted: "+1 ••••" }),
      contact({ name: "Mom", jid: "+2", redacted: "+2 ••••" }),
    ]);
    const onPick = vi.fn();
    render(<ContactPickerSlot spec={spec} onPick={onPick} list={list} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("contact-picker-row")).toHaveLength(2);
    });
    const input = screen.getByTestId("contact-picker-search");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({
      kind: "contact",
      jid: "+2",
      name: "Mom",
    });
  });

  it("clicking a row dispatches onPick", async () => {
    const list = listFactory([
      contact({ name: "Jose", jid: "+1", redacted: "+1 ••••" }),
    ]);
    const onPick = vi.fn();
    render(<ContactPickerSlot spec={spec} onPick={onPick} list={list} />);
    const row = await screen.findByTestId("contact-picker-row");
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ name: "Jose" });
  });

  it("'+ Pair new' (non-empty state) fires onAddNew", async () => {
    const list = listFactory([contact()]);
    const onAddNew = vi.fn();
    render(
      <ContactPickerSlot
        spec={spec}
        onPick={vi.fn()}
        list={list}
        onAddNew={onAddNew}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("contact-picker-add-new")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("contact-picker-add-new"));
    expect(onAddNew).toHaveBeenCalledTimes(1);
  });

  it("renders the 'no match' line when the search has no hits", async () => {
    const list = listFactory([contact({ name: "Jose" })]);
    render(<ContactPickerSlot spec={spec} onPick={vi.fn()} list={list} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("contact-picker-row")).toHaveLength(1);
    });
    fireEvent.change(screen.getByTestId("contact-picker-search"), {
      target: { value: "xyz" },
    });
    await waitFor(() => {
      expect(screen.queryAllByTestId("contact-picker-row")).toHaveLength(0);
    });
  });

  // Phase 5.5 completion mini-diff 2 — free-text E.164 entry. The
  // picker is the gateway to the WhatsApp slash flow; forcing users
  // through a SAS-pair step before they can message a number they
  // know is wrong. The resolver already has an E.164 escape hatch;
  // the picker now mirrors it.
  describe("free-text E.164 entry", () => {
    it("empty state shows the search input (not an alternate empty layout)", async () => {
      const list = listFactory([]);
      render(<ContactPickerSlot spec={spec} onPick={vi.fn()} list={list} />);
      await waitFor(() => {
        expect(screen.getByTestId("contact-picker-empty")).toBeTruthy();
      });
      expect(screen.getByTestId("contact-picker-search")).toBeTruthy();
    });

    it("Enter on a valid E.164 dispatches onPick with the raw phone (empty state)", async () => {
      const list = listFactory([]);
      const onPick = vi.fn();
      render(<ContactPickerSlot spec={spec} onPick={onPick} list={list} />);
      await waitFor(() => {
        expect(screen.getByTestId("contact-picker-empty")).toBeTruthy();
      });
      const input = screen.getByTestId("contact-picker-search");
      fireEvent.change(input, { target: { value: "+5215512345678" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onPick).toHaveBeenCalledWith({
        kind: "contact",
        jid: "+5215512345678",
        name: "+5215512345678",
      });
    });

    it("E.164 in the search wins over the highlighted contact (non-empty state)", async () => {
      // Even when contacts are loaded and one is highlighted, typing a
      // valid E.164 + Enter should dispatch the typed phone, not the
      // SAS contact under the cursor.
      const list = listFactory([
        contact({ name: "Jose", jid: "+1", redacted: "+1 ••••" }),
      ]);
      const onPick = vi.fn();
      render(<ContactPickerSlot spec={spec} onPick={onPick} list={list} />);
      await waitFor(() => {
        expect(screen.getAllByTestId("contact-picker-row")).toHaveLength(1);
      });
      const input = screen.getByTestId("contact-picker-search");
      fireEvent.change(input, { target: { value: "+5215512345678" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onPick).toHaveBeenCalledWith({
        kind: "contact",
        jid: "+5215512345678",
        name: "+5215512345678",
      });
      // Must not double-fire.
      expect(onPick).toHaveBeenCalledTimes(1);
    });

    it("renders the raw-phone hint when the query parses as E.164 and no SAS row matches", async () => {
      const list = listFactory([contact({ name: "Jose" })]);
      render(<ContactPickerSlot spec={spec} onPick={vi.fn()} list={list} />);
      await waitFor(() => {
        expect(screen.getAllByTestId("contact-picker-row")).toHaveLength(1);
      });
      fireEvent.change(screen.getByTestId("contact-picker-search"), {
        target: { value: "+5215512345678" },
      });
      await waitFor(() => {
        expect(
          screen.getByTestId("contact-picker-raw-phone-hint"),
        ).toBeTruthy();
      });
    });

    it("Enter on a non-E.164 query with no list match is a no-op", async () => {
      const list = listFactory([contact({ name: "Jose" })]);
      const onPick = vi.fn();
      render(<ContactPickerSlot spec={spec} onPick={onPick} list={list} />);
      await waitFor(() => {
        expect(screen.getAllByTestId("contact-picker-row")).toHaveLength(1);
      });
      const input = screen.getByTestId("contact-picker-search");
      fireEvent.change(input, { target: { value: "xyz" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onPick).not.toHaveBeenCalled();
    });

    it("does NOT dispatch on near-E.164 strings (must start with + and only digits)", async () => {
      const list = listFactory([]);
      const onPick = vi.fn();
      render(<ContactPickerSlot spec={spec} onPick={onPick} list={list} />);
      await waitFor(() => {
        expect(screen.getByTestId("contact-picker-empty")).toBeTruthy();
      });
      const input = screen.getByTestId("contact-picker-search");
      // Missing leading +.
      fireEvent.change(input, { target: { value: "5215512345678" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onPick).not.toHaveBeenCalled();
      // Letters embedded.
      fireEvent.change(input, { target: { value: "+5215abc12345" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onPick).not.toHaveBeenCalled();
    });
  });

  // Phase 5.5 completion — inline pair flow (replaces the navigate-away bug).
  describe("inline WhatsApp pair flow", () => {
    /**
     * Lightweight mock that mirrors the real component's API and
     * exposes its callbacks via `data-testid` buttons so tests can
     * drive the lifecycle without spinning up Tauri events.
     */
    function makeMockFlow(): {
      Component: React.FC<PairFlowComponentProps>;
      lastProps: () => PairFlowComponentProps | null;
    } {
      let captured: PairFlowComponentProps | null = null;
      const Component: React.FC<PairFlowComponentProps> = (props) => {
        captured = props;
        if (!props.open) return null;
        return (
          <div data-testid="mock-pair-flow">
            <button
              type="button"
              data-testid="mock-pair-flow-resolve"
              onClick={() =>
                props.onPaired({
                  jid: "+5215599999999",
                  name: "Newly Paired",
                  redacted: "+52 ••••9999",
                })
              }
            >
              resolve
            </button>
            <button
              type="button"
              data-testid="mock-pair-flow-close"
              onClick={() => props.onClose()}
            >
              close
            </button>
          </div>
        );
      };
      return { Component, lastProps: () => captured };
    }

    it("opens the inline pair flow when '+ Pair new' is clicked (no onAddNew override)", async () => {
      const list = listFactory([]);
      const { Component } = makeMockFlow();
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          PairFlowComponent={Component}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("contact-picker-empty")).toBeTruthy();
      });
      // Modal hidden by default.
      expect(screen.queryByTestId("mock-pair-flow")).toBeNull();
      fireEvent.click(screen.getByTestId("contact-picker-add-new"));
      expect(screen.getByTestId("mock-pair-flow")).toBeTruthy();
    });

    it("onPaired resumes the slash command with the new contact", async () => {
      const list = listFactory([]);
      const onPick = vi.fn();
      const { Component } = makeMockFlow();
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={onPick}
          list={list}
          PairFlowComponent={Component}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("contact-picker-empty")).toBeTruthy();
      });
      fireEvent.click(screen.getByTestId("contact-picker-add-new"));
      fireEvent.click(screen.getByTestId("mock-pair-flow-resolve"));
      expect(onPick).toHaveBeenCalledWith({
        kind: "contact",
        jid: "+5215599999999",
        name: "Newly Paired",
      });
      // Modal closes after pick resolves.
      await waitFor(() => {
        expect(screen.queryByTestId("mock-pair-flow")).toBeNull();
      });
    });

    it("onClose keeps the picker visible and does not dispatch onPick", async () => {
      const list = listFactory([contact({ name: "Jose" })]);
      const onPick = vi.fn();
      const { Component } = makeMockFlow();
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={onPick}
          list={list}
          PairFlowComponent={Component}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("contact-picker")).toBeTruthy();
      });
      fireEvent.click(screen.getByTestId("contact-picker-add-new"));
      expect(screen.getByTestId("mock-pair-flow")).toBeTruthy();
      fireEvent.click(screen.getByTestId("mock-pair-flow-close"));
      await waitFor(() => {
        expect(screen.queryByTestId("mock-pair-flow")).toBeNull();
      });
      // Picker remains visible, no pick fired.
      expect(screen.getByTestId("contact-picker")).toBeTruthy();
      expect(onPick).not.toHaveBeenCalled();
    });

    it("onAddNew override still suppresses the inline flow", async () => {
      const list = listFactory([]);
      const onAddNew = vi.fn();
      const { Component } = makeMockFlow();
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          onAddNew={onAddNew}
          PairFlowComponent={Component}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("contact-picker-empty")).toBeTruthy();
      });
      fireEvent.click(screen.getByTestId("contact-picker-add-new"));
      expect(onAddNew).toHaveBeenCalledTimes(1);
      // The inline flow should NOT have been opened.
      expect(screen.queryByTestId("mock-pair-flow")).toBeNull();
    });
  });

  // Phase 5.5 completion mini-diff 3 — empty state reads Baileys state
  // so it stops telling the user to "Pair WhatsApp account" once they
  // already have a linked account.
  describe("empty state adapts to Baileys-connected state", () => {
    it("shows 'WhatsApp ready' copy + hides the pair CTA when a Baileys account is connected", async () => {
      const list = listFactory([]);
      const listAccounts = accountsFactory([connectedAccount()]);
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          listAccounts={listAccounts}
        />,
      );
      const empty = await screen.findByTestId("contact-picker-empty");
      expect(empty.getAttribute("data-whatsapp-ready")).toBe("true");
      expect(empty.textContent).toContain("WhatsApp ready");
      // CTA must be gone — the user is already paired.
      expect(screen.queryByTestId("contact-picker-add-new")).toBeNull();
    });

    it("shows 'pair WhatsApp first' copy + the pair CTA when no Baileys account is connected", async () => {
      const list = listFactory([]);
      const listAccounts = accountsFactory([]);
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          listAccounts={listAccounts}
        />,
      );
      const empty = await screen.findByTestId("contact-picker-empty");
      expect(empty.getAttribute("data-whatsapp-ready")).toBe("false");
      expect(empty.textContent).toContain("No WhatsApp account paired");
      expect(screen.getByTestId("contact-picker-add-new")).toBeTruthy();
    });

    it("treats qr_pending / disconnected accounts as 'not ready'", async () => {
      const list = listFactory([]);
      const listAccounts = accountsFactory([
        connectedAccount({ status: "qr_pending" }),
        connectedAccount({ account_id: "acc-2", status: "disconnected" }),
      ]);
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          listAccounts={listAccounts}
        />,
      );
      const empty = await screen.findByTestId("contact-picker-empty");
      expect(empty.getAttribute("data-whatsapp-ready")).toBe("false");
      expect(screen.getByTestId("contact-picker-add-new")).toBeTruthy();
    });

    it("treats a reconnecting account as 'ready' (Baileys auto-recovers)", async () => {
      const list = listFactory([]);
      const listAccounts = accountsFactory([
        connectedAccount({ status: "reconnecting" }),
      ]);
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          listAccounts={listAccounts}
        />,
      );
      const empty = await screen.findByTestId("contact-picker-empty");
      expect(empty.getAttribute("data-whatsapp-ready")).toBe("true");
      expect(screen.queryByTestId("contact-picker-add-new")).toBeNull();
    });

    it("Enter on a valid E.164 still dispatches in the connected empty state", async () => {
      const list = listFactory([]);
      const listAccounts = accountsFactory([connectedAccount()]);
      const onPick = vi.fn();
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={onPick}
          list={list}
          listAccounts={listAccounts}
        />,
      );
      await screen.findByTestId("contact-picker-empty");
      const input = screen.getByTestId("contact-picker-search");
      fireEvent.change(input, { target: { value: "+5215512345678" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onPick).toHaveBeenCalledWith({
        kind: "contact",
        jid: "+5215512345678",
        name: "+5215512345678",
      });
    });
  });

  // Phase 5.5 completion mini-diff 5 — fast follow-up sends. Recently
  // messaged recipients are promoted above the SAS list so the user
  // doesn't have to retype the phone every time.
  describe("scoped-memory promotion of recent recipients", () => {
    function memoryWithContact(jid: string, name: string): ScopedMemory {
      const mem = new ScopedMemory();
      mem.push({
        commandName: "whatsapp",
        args: { to: jid, message: "hola" },
        summary: `Sent WhatsApp to ${name}`,
        entities: [{ type: "contact", jid, name }],
      });
      return mem;
    }

    it("promotes a memory-only contact to the top with a 'recent' badge", async () => {
      const list = listFactory([]);
      const scopedMemory = memoryWithContact(
        "+526692442956",
        "+526692442956",
      );
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          scopedMemory={scopedMemory}
        />,
      );
      const row = await screen.findByTestId("contact-picker-row");
      expect(row.getAttribute("data-promoted")).toBe("true");
      expect(row.textContent).toContain("+526692442956");
    });

    it("Enter on a memory-promoted row dispatches that contact (fast follow-up)", async () => {
      const list = listFactory([]);
      const scopedMemory = memoryWithContact(
        "+526692442956",
        "+526692442956",
      );
      const onPick = vi.fn();
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={onPick}
          list={list}
          scopedMemory={scopedMemory}
        />,
      );
      await screen.findByTestId("contact-picker-row");
      const input = screen.getByTestId("contact-picker-search");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onPick).toHaveBeenCalledWith({
        kind: "contact",
        jid: "+526692442956",
        name: "+526692442956",
      });
    });

    it("dedupes by jid: SAS name wins, promoted flag stays", async () => {
      const list = listFactory([
        contact({ name: "Jose", jid: "+1", redacted: "+1 ••••" }),
      ]);
      const scopedMemory = memoryWithContact("+1", "+1");
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          scopedMemory={scopedMemory}
        />,
      );
      const rows = await screen.findAllByTestId("contact-picker-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.getAttribute("data-promoted")).toBe("true");
      // SAS display name wins over the raw-phone fallback in memory.
      expect(rows[0]!.textContent).toContain("Jose");
    });

    it("promoted row appears ABOVE the SAS list when both are present", async () => {
      const list = listFactory([
        contact({ name: "Older", jid: "+oldjid", redacted: "+••••old" }),
      ]);
      const scopedMemory = memoryWithContact(
        "+526692442956",
        "+526692442956",
      );
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          scopedMemory={scopedMemory}
        />,
      );
      const rows = await screen.findAllByTestId("contact-picker-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.getAttribute("data-promoted")).toBe("true");
      expect(rows[0]!.textContent).toContain("+526692442956");
      expect(rows[1]!.getAttribute("data-promoted")).toBeNull();
      expect(rows[1]!.textContent).toContain("Older");
    });
  });

  // Pure-function tests for the helpers exported alongside the
  // component. Kept close to the component so the picker's invariants
  // travel with its public surface.
  describe("helpers", () => {
    it("redactedFromJid keeps the last 4 digits", () => {
      expect(redactedFromJid("+5215512345678")).toBe("…5678");
      expect(redactedFromJid("+1234")).toBe("…1234");
      expect(redactedFromJid("12")).toBe("12"); // too short — passthrough
    });

    it("contactsFromMemory yields contacts newest-first across multiple entries", () => {
      const mem = new ScopedMemory();
      mem.push({
        commandName: "whatsapp",
        args: {},
        summary: "",
        entities: [{ type: "contact", jid: "+1", name: "first" }],
      });
      mem.push({
        commandName: "whatsapp",
        args: {},
        summary: "",
        entities: [{ type: "contact", jid: "+2", name: "second" }],
      });
      const out = contactsFromMemory(mem.recent());
      expect(out.map((c) => c.jid)).toEqual(["+2", "+1"]);
    });

    it("mergeContactSources dedupes + preserves promoted ordering", () => {
      const promoted: ContactEntity[] = [
        { jid: "+a", name: "memA", redacted: "…a" },
        { jid: "+b", name: "memB", redacted: "…b" },
      ];
      const fresh: ContactEntity[] = [
        { jid: "+b", name: "sasB", redacted: "•••b" },
        { jid: "+c", name: "sasC", redacted: "•••c" },
      ];
      const merged = mergeContactSources(promoted, fresh);
      expect(merged.map((r) => r.entity.jid)).toEqual(["+a", "+b", "+c"]);
      expect(merged.map((r) => r.promoted)).toEqual([true, true, false]);
      // SAS name wins on dedupe.
      expect(merged[1]!.entity.name).toBe("sasB");
    });
  });

  // Phase 5.5 completion mini-diff 7 — persistent recent contacts.
  // The SAME contact picker now reads `desktop_recent_contacts_list`
  // via the `listRecent` prop so recipients messaged in a PREVIOUS
  // dock session show up as promoted rows on next boot.
  describe("persistent recent-contacts promotion", () => {
    it("promotes a persistent recent (no scoped memory) with the 'recent' badge", async () => {
      const list = listFactory([]);
      const listRecent = vi.fn(async () => [
        contact({
          jid: "+5215511112222",
          name: "+5215511112222",
          redacted: "…2222",
        }),
      ]);
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          listRecent={listRecent}
        />,
      );
      const row = await screen.findByTestId("contact-picker-row");
      expect(row.getAttribute("data-promoted")).toBe("true");
      expect(row.textContent).toContain("+5215511112222");
    });

    it("scoped memory beats persistent recent on ordering when both have the same jid", async () => {
      // Edge case: in the SAME dock session, scoped memory and the
      // persistent store both record the recipient. The picker should
      // surface a SINGLE row (not two) and use the scoped-memory entry.
      const list = listFactory([]);
      const scopedMemory = memoryWithContact("+1", "memName");
      const listRecent = vi.fn(async () => [
        contact({ jid: "+1", name: "persistedName", redacted: "…1" }),
      ]);
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          listRecent={listRecent}
          scopedMemory={scopedMemory}
        />,
      );
      const rows = await screen.findAllByTestId("contact-picker-row");
      expect(rows).toHaveLength(1);
      // Memory contact's contactFromResolved derives name = "memName".
      expect(rows[0]!.textContent).toContain("memName");
    });

    it("persistent recent + fresh SAS contact render as separate rows, recent first", async () => {
      const list = listFactory([
        contact({ name: "Jose", jid: "+sas", redacted: "•••sas" }),
      ]);
      const listRecent = vi.fn(async () => [
        contact({
          jid: "+recent",
          name: "+recent",
          redacted: "…ecnt",
        }),
      ]);
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          listRecent={listRecent}
        />,
      );
      const rows = await screen.findAllByTestId("contact-picker-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.getAttribute("data-promoted")).toBe("true");
      expect(rows[0]!.textContent).toContain("+recent");
      expect(rows[1]!.getAttribute("data-promoted")).toBeNull();
      expect(rows[1]!.textContent).toContain("Jose");
    });

    it("falls through silently when listRecent rejects", async () => {
      const list = listFactory([]);
      const listRecent = vi.fn(async () => {
        throw new Error("ipc unavailable");
      });
      render(
        <ContactPickerSlot
          spec={spec}
          onPick={vi.fn()}
          list={list}
          listRecent={listRecent}
        />,
      );
      // Picker still mounts; just shows the empty state.
      await screen.findByTestId("contact-picker-empty");
    });
  });
});

// Helper used by both scoped-memory and persistent-recent test groups.
// Hoisted to the outer scope so the persistent-recent suite can reuse
// it without depending on the scoped-memory `describe` block's closure.
function memoryWithContact(jid: string, name: string): ScopedMemory {
  const mem = new ScopedMemory();
  mem.push({
    commandName: "whatsapp",
    args: { to: jid, message: "hola" },
    summary: `Sent WhatsApp to ${name}`,
    entities: [{ type: "contact", jid, name }],
  });
  return mem;
}
