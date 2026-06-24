/**
 * Phase 5.5 — paired contact picker.
 *
 * Renders the contacts returned by `listContacts()` (Phase 5.2 entity
 * provider). Two surfaces complement each other so the picker stays
 * useful regardless of whether the user has SAS-paired specific
 * recipients in advance:
 *
 *   - List of SAS-paired contacts (searchable, click or Enter to pick).
 *   - Free-text phone entry (E.164) in the SAME input: typing
 *     `+5215512345678` and pressing Enter dispatches a raw-phone
 *     pick. Matches the E.164 escape hatch in
 *     `resolveWhatsAppRecipient` — `desktop_whatsapp_list_paired`
 *     covers ONE pre-pair flow (SAS), but a Baileys-linked account
 *     can message any number, and the picker shouldn't gate that.
 *
 * The "+ Pair new" affordance opens `WhatsAppPairDialog` INLINE (Phase
 * 5.5 completion — the original 5.5 navigated to Settings → Channels,
 * which silently dropped the user off the slash flow). On a
 * successful pair we refetch contacts and, when the linked self_jid
 * matches an existing SAS entry, auto-resume; otherwise we close and
 * let the user type a recipient directly.
 */
import { Clock, Plus, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { InlineWhatsAppPairFlow } from "./InlineWhatsAppPairFlow";
import {
  listContacts,
  listRecentContacts,
} from "@/lib/slash/entities/contacts";
import type { ContactEntity } from "@/lib/slash/entities/types";
import type {
  MemoryEntry,
  ResolvedEntity,
  ScopedMemory,
} from "@/lib/slash/scoped-memory";
import type { SlotSpec, SlotValue } from "@/lib/slash/suspended-command";
import {
  hasSendableAccount,
  listWhatsAppAccounts,
  type WhatsAppAccountInfo,
} from "@/lib/whatsapp-accounts";

interface PickerRow {
  entity: ContactEntity;
  /** True when this row came from scoped memory (recently messaged). */
  promoted: boolean;
}

/**
 * Pull contact entities out of scoped memory, newest entry first.
 * Mirrors `projectsFromMemory` from the project picker — keeps the
 * picker stateless while still giving the dock the "follow-up to the
 * same chat is fast" behaviour the user expects.
 */
export function contactsFromMemory(
  entries: readonly MemoryEntry[],
): ContactEntity[] {
  const out: ContactEntity[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    for (const e of entry.entities) {
      if (e.type === "contact") {
        out.push(contactFromResolved(e));
      }
    }
  }
  return out;
}

function contactFromResolved(
  e: Extract<ResolvedEntity, { type: "contact" }>,
): ContactEntity {
  return {
    jid: e.jid,
    name: e.name,
    redacted: redactedFromJid(e.jid),
  };
}

/**
 * Derive a redacted hint from a phone-style JID. When the typed name
 * already IS the phone (typical `/whatsapp +52…` flow), the picker
 * row would render the same string twice; the caller suppresses the
 * second column in that case. Pure function — exposed for tests.
 */
export function redactedFromJid(jid: string): string {
  const digits = jid.replace(/\D/g, "");
  if (digits.length < 4) return jid;
  return `…${digits.slice(-4)}`;
}

/**
 * Merge memory-promoted contacts with the fresh SAS list. Promoted
 * wins on dedupe so the recency signal is preserved; when a fresh
 * entry has a richer name (e.g. SAS-paired "Jose" vs the raw E.164
 * the user typed), we prefer the SAS name but keep the promoted
 * flag.
 */
export function mergeContactSources(
  promoted: ContactEntity[],
  fresh: readonly ContactEntity[],
): PickerRow[] {
  const freshByJid = new Map(fresh.map((c) => [c.jid, c]));
  const seen = new Set<string>();
  const out: PickerRow[] = [];
  for (const p of promoted) {
    if (seen.has(p.jid)) continue;
    seen.add(p.jid);
    const sas = freshByJid.get(p.jid);
    const merged: ContactEntity = sas
      ? { ...sas } // SAS name + redacted win when available
      : p;
    out.push({ entity: merged, promoted: true });
  }
  for (const c of fresh) {
    if (seen.has(c.jid)) continue;
    seen.add(c.jid);
    out.push({ entity: c, promoted: false });
  }
  return out;
}

/** Shape of the pair-flow component — narrow enough for test mocks. */
export interface PairFlowComponentProps {
  open: boolean;
  onClose: () => void;
  onPaired: (contact: ContactEntity) => void;
}

/**
 * Same shape the slash resolver's `resolveWhatsAppRecipient` uses for
 * its E.164 escape hatch. Kept locally so the picker doesn't have to
 * import from the dispatch layer.
 */
const E164 = /^\+[1-9][0-9]{6,14}$/;

export interface ContactPickerSlotProps {
  spec: SlotSpec;
  onPick: (value: SlotValue) => void;
  /**
   * Test injection — overrides the live `listContacts()` provider.
   * Production callers leave this undefined.
   */
  list?: typeof listContacts;
  /**
   * Test injection — replaces the "+ Pair new" handler entirely
   * (bypasses the inline modal). When set, the picker calls this
   * instead of opening the pair flow. Production callers leave this
   * undefined.
   */
  onAddNew?: () => void;
  /**
   * Test injection — substitutes the inline WhatsApp pair flow with a
   * mock component so unit tests can drive `onPaired` / `onClose`
   * without spinning up the Tauri sidecar. Production callers leave
   * this undefined; the real `InlineWhatsAppPairFlow` is used.
   */
  PairFlowComponent?: React.ComponentType<PairFlowComponentProps>;
  /**
   * Test injection — overrides the live `listWhatsAppAccounts()`
   * provider. Used to assert empty-state copy + CTA variation across
   * connected vs disconnected Baileys states. Production callers
   * leave this undefined.
   */
  listAccounts?: typeof listWhatsAppAccounts;
  /**
   * Test injection — overrides the persistent recent-contacts provider
   * (`desktop_recent_contacts_list` IPC under the hood). When set, the
   * picker uses this as the cross-session "promoted" source instead.
   * Production callers leave this undefined.
   */
  listRecent?: typeof listRecentContacts;
  /**
   * Scoped-memory accessor — when provided, recently-messaged
   * recipients (recorded by the /whatsapp dispatcher on a successful
   * send) get promoted to the top of the list with a "recent" badge.
   * In-session only; the persistent recent-contacts store
   * (`listRecent`) is the cross-restart equivalent. Both are merged
   * with scoped memory taking precedence within a session.
   */
  scopedMemory?: ScopedMemory;
}

export function ContactPickerSlot({
  spec,
  onPick,
  list = listContacts,
  onAddNew,
  PairFlowComponent = InlineWhatsAppPairFlow,
  listAccounts = listWhatsAppAccounts,
  listRecent = listRecentContacts,
  scopedMemory,
}: ContactPickerSlotProps) {
  const [contacts, setContacts] = useState<readonly ContactEntity[] | null>(
    null,
  );
  const [recent, setRecent] = useState<readonly ContactEntity[]>([]);
  const [accounts, setAccounts] = useState<readonly WhatsAppAccountInfo[]>([]);
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const [pairingOpen, setPairingOpen] = useState(false);
  // Bumped after a pair attempt resolves so the contact list refetches
  // even when no auto-pick fires — the new pairing might surface as a
  // contact a few hundred ms after `whatsapp:linked` lands.
  const [refetchToken, setRefetchToken] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Catch per-source so a single failing provider doesn't strand
    // the picker in the loading state. The persistent recents call
    // is the most failure-prone (Tauri IPC); already-resilient
    // providers (jsdom-safe `listContacts`/`listWhatsAppAccounts`)
    // just return empty arrays on their own.
    void Promise.all([
      list().catch(() => [] as ContactEntity[]),
      listAccounts().catch(() => [] as WhatsAppAccountInfo[]),
      listRecent().catch(() => [] as ContactEntity[]),
    ]).then(([rows, accs, recents]) => {
      if (cancelled) return;
      setContacts(rows);
      setAccounts(accs);
      setRecent(recents);
    });
    return () => {
      cancelled = true;
    };
  }, [list, listAccounts, listRecent, refetchToken]);

  // Focus the search input on mount so the user can type immediately
  // without an extra click. The outer SlotPicker steals focus first;
  // we override on the next frame.
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const promoted = useMemo<ContactEntity[]>(() => {
    // Scoped memory (in-session) wins ordering over the persistent
    // store within a single dock lifetime — the user's most recent
    // /whatsapp from THIS session should sit at the very top. After
    // an app restart scoped memory is empty and the persistent store
    // alone carries the recency signal across sessions.
    const fromMemory = scopedMemory
      ? contactsFromMemory(scopedMemory.recent())
      : [];
    // Dedup the persistent list against scoped memory (same jid → keep
    // memory ordering). Otherwise append in DESC-by-recency order.
    const seen = new Set(fromMemory.map((c) => c.jid));
    const fromRecent = recent.filter((c) => !seen.has(c.jid));
    return [...fromMemory, ...fromRecent];
  }, [scopedMemory, recent]);

  const rows = useMemo<PickerRow[]>(
    () => mergeContactSources(promoted, contacts ?? []),
    [promoted, contacts],
  );

  const filtered = useMemo<PickerRow[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    // Name-only filter — typing a phone number doesn't match contacts
    // by jid even when the digits overlap, so the raw-phone hint can
    // fire and the user dispatches the typed phone deliberately.
    return rows.filter((r) => r.entity.name.toLowerCase().includes(q));
  }, [rows, query]);

  // Re-clamp the highlight when the filter changes.
  useEffect(() => {
    if (filtered.length === 0) {
      setIdx(0);
    } else if (idx >= filtered.length) {
      setIdx(filtered.length - 1);
    }
  }, [filtered, idx]);

  const trimmedQuery = query.trim();
  const queryIsE164 = E164.test(trimmedQuery);

  const handlePick = useCallback(
    (contact: ContactEntity) => {
      onPick({ kind: "contact", jid: contact.jid, name: contact.name });
    },
    [onPick],
  );

  const handlePickRawPhone = useCallback(
    (phone: string) => {
      // Raw E.164 dispatch — no SAS entity backs this. Surface the
      // typed phone as both jid and display name; the slash rebuilder
      // re-runs `parseWhatsAppArgs` on the rebuilt string and the
      // E.164 escape hatch in `resolveWhatsAppRecipient` passes it
      // straight through to `comm.send_whatsapp`.
      onPick({ kind: "contact", jid: phone, name: phone });
    },
    [onPick],
  );

  const handleAddNew = useCallback(() => {
    if (onAddNew) {
      onAddNew();
      return;
    }
    // Production: open the WhatsApp Baileys pair dialog INLINE so the
    // user stays inside the slash flow. The dock surface keeps the
    // partial command alive; on a successful pair-and-match we resume
    // with the new contact, on cancel the picker stays visible.
    setPairingOpen(true);
  }, [onAddNew]);

  const handlePairClose = useCallback(() => {
    setPairingOpen(false);
    setRefetchToken((t) => t + 1);
  }, []);

  const handlePaired = useCallback(
    (contact: ContactEntity) => {
      setPairingOpen(false);
      setRefetchToken((t) => t + 1);
      handlePick(contact);
    },
    [handlePick],
  );

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // E.164 typed directly wins over the highlighted contact. This
      // matches the resolver's escape-hatch precedence and lets the
      // user dispatch deliberately to any number without first
      // pairing it through SAS.
      if (queryIsE164) {
        handlePickRawPhone(trimmedQuery);
        return;
      }
      const target = filtered[idx];
      if (target) handlePick(target.entity);
    }
  };

  // Loading state — first render, contacts === null. Distinct from
  // "loaded but empty" so the user knows we're still waiting.
  if (contacts === null) {
    return (
      <Loading text={spec.placeholder ?? "Loading contacts..."} />
    );
  }

  const hasRows = rows.length > 0;
  const showRawPhoneHint = queryIsE164 && filtered.length === 0;
  const whatsappReady = hasSendableAccount(accounts);

  return (
    <div data-testid="contact-picker">
      <div
        className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-md"
        style={{
          background: "var(--bg-elev-2, var(--surface))",
          border: "1px solid var(--border)",
        }}
      >
        <Search size={13} strokeWidth={1.6} style={{ color: "var(--text-faint)" }} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            spec.placeholder ?? "Search contacts or type +12025550100…"
          }
          aria-label="Search contacts or enter phone"
          data-testid="contact-picker-search"
          className="flex-1 bg-transparent text-[13px] outline-none border-none"
          style={{ color: "var(--text)" }}
        />
      </div>

      {showRawPhoneHint ? (
        <div
          data-testid="contact-picker-raw-phone-hint"
          className="text-[12px] px-3 py-2 rounded-md mb-2"
          style={{
            background: "var(--bg-elev-2, var(--surface))",
            color: "var(--text-subtle)",
          }}
        >
          Press <kbd>Enter</kbd> to send to{" "}
          <span className="font-mono" style={{ color: "var(--text)" }}>
            {trimmedQuery}
          </span>
          .
        </div>
      ) : null}

      {hasRows ? (
        <ul
          role="listbox"
          aria-label="Paired contacts"
          className="max-h-[180px] overflow-auto rounded-md"
          style={{ background: "var(--bg-elev-2, var(--surface))" }}
        >
          {filtered.length === 0 ? (
            <li
              className="px-3 py-2 text-[12px]"
              style={{ color: "var(--text-faint)" }}
            >
              No contact matches <code>{query}</code>.
            </li>
          ) : (
            filtered.map((row, i) => {
              const c = row.entity;
              // When the name IS the phone (raw E.164 input, typical
              // post-/whatsapp memory promotion), suppress the redacted
              // second column so the same digits don't render twice.
              const redactedRedundant = c.name === c.jid;
              return (
                <li
                  key={c.jid}
                  role="option"
                  aria-selected={i === idx}
                  data-testid="contact-picker-row"
                  data-promoted={row.promoted ? "true" : undefined}
                  data-selected={i === idx ? "true" : undefined}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => handlePick(c)}
                  className="palette-row px-3 py-1.5 cursor-pointer flex items-center justify-between gap-2"
                  style={{
                    fontSize: 13,
                    color: "var(--text)",
                  }}
                >
                  <span className="flex-1 truncate">{c.name}</span>
                  {row.promoted ? (
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] tracking-[0.04em] flex items-center gap-1 shrink-0"
                      style={{
                        background: "var(--bg-elev-3, transparent)",
                        color: "var(--text-subtle)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      <Clock size={9} strokeWidth={1.6} /> recent
                    </span>
                  ) : null}
                  {redactedRedundant ? null : (
                    <span
                      className="font-mono shrink-0"
                      style={{ color: "var(--text-faint)", fontSize: 11 }}
                    >
                      {c.redacted}
                    </span>
                  )}
                </li>
              );
            })
          )}
        </ul>
      ) : (
        <div
          data-testid="contact-picker-empty"
          data-whatsapp-ready={whatsappReady ? "true" : "false"}
          className="px-3 py-3 rounded-md text-[12px]"
          style={{
            background: "var(--bg-elev-2, var(--surface))",
            color: "var(--text-subtle)",
            border: "1px dashed var(--border)",
            textAlign: "center",
          }}
        >
          {whatsappReady ? (
            <>
              <span style={{ color: "var(--verified, var(--text))" }}>
                WhatsApp ready.
              </span>{" "}
              Type a phone number (
              <span className="font-mono" style={{ color: "var(--text)" }}>
                +12025550100
              </span>
              ) and press <kbd>Enter</kbd>.
            </>
          ) : (
            <>
              No WhatsApp account paired.
              <br />
              Pair WhatsApp to start sending messages.
            </>
          )}
        </div>
      )}

      {/*
       * The pair-account CTA is only useful when Baileys isn't
       * already linked (or when the user explicitly wants to add a
       * second account, which the picker doesn't surface — they
       * can go to Settings → Channels for multi-account flows).
       * Hiding it in the connected state removes the confusing
       * "Pair WhatsApp account" prompt that suggests the user
       * isn't paired when they are.
       */}
      {whatsappReady ? null : (
        <button
          type="button"
          onClick={handleAddNew}
          data-testid="contact-picker-add-new"
          className="mt-2 w-full px-3 py-1.5 rounded-md text-[12px] flex items-center justify-center gap-1.5"
          style={{
            background: "var(--bg-elev-2, var(--surface))",
            color: "var(--text-subtle)",
            border: "1px dashed var(--border)",
          }}
        >
          <Plus size={12} strokeWidth={1.8} />
          Pair WhatsApp account
        </button>
      )}

      <PairFlowComponent
        open={pairingOpen}
        onClose={handlePairClose}
        onPaired={handlePaired}
      />
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div
      data-testid="contact-picker-loading"
      className="text-[12px] py-4 text-center"
      style={{ color: "var(--text-faint)" }}
    >
      {text}
    </div>
  );
}
