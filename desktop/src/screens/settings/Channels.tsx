/**
 * Settings → Channels (S8 + S12 + 2026-05-07 design pivot).
 *
 * Channel-tab picker on top (WhatsApp · Telegram · Slack · Mobile)
 * with paired-entity counts per tab. Active tab shows its paired
 * entities in a single list pattern. Pair button at the bottom is
 * primary cream; "Show pairing log" link aligns right.
 *
 * Telegram / Slack don't yet support desktop-side pairing — they're
 * authenticated at the workspace level via OAuth. Their tabs render
 * a quiet helper card explaining where to configure them, keeping
 * the channel grid uniform.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ArrowRight, KeyRound, MoreHorizontal, Plus, Smartphone } from "lucide-react";

import { errorToString } from "@/lib/errors";
import { PairingCodeModal } from "@/components/pairing/PairingCodeModal";
import { WhatsAppPairDialog } from "@/components/pairing/WhatsAppPairDialog";
import {
  SasConfirmModal,
  type SasPendingState,
} from "@/components/pairing/SasConfirmModal";
import {
  pairingConfirm,
  pairingList,
  pairingRevoke,
  mobilePairingGenerate,
  mobilePairingConfirm,
  type PairedEntityDto,
  type PendingPairingDto,
} from "@/lib/main-ipc";

// WhatsApp Baileys backend lives in a different table (whatsapp_accounts)
// than the SAS pairing primitive (paired_entities). The Channels UI is
// meant to be a unified surface, so we merge both sources at fetch time
// via `whatsAppAccountsToEntities` and route revokes back to the correct
// backend with the `wa:` prefix sentinel on entity IDs.
type WhatsAppConnectionStatus =
  | "disconnected"
  | "qr_pending"
  | "connected"
  | "reconnecting"
  | "failed";

interface WhatsAppAccountInfo {
  account_id: string;
  label: string;
  self_jid: string | null;
  status: WhatsAppConnectionStatus;
  last_qr_at_ms: number | null;
  last_linked_at_ms: number | null;
}

interface WhatsAppQrUpdateEvent {
  account_id: string;
  qr: string;
  ts_ms: number;
}

interface WhatsAppLinkedEvent {
  account_id: string;
  self_jid: string;
  ts_ms: number;
}

const WA_ENTITY_PREFIX = "wa:";

function whatsAppAccountsToEntities(accounts: WhatsAppAccountInfo[]): PairedEntityDto[] {
  return accounts
    // Only fully linked accounts belong in the unified list. Mid-pair
    // (qr_pending) and broken (disconnected/failed) sessions are
    // surfaced through the pair dialog itself; they would clutter the
    // "verified" list.
    .filter((a) => a.status === "connected" || a.status === "reconnecting")
    .map((a) => {
      const jid = a.self_jid ?? "";
      // self_jid format: `<digits>@s.whatsapp.net`. Surface the last 4
      // digits, matching the backend's redacted_identifier convention
      // for paired_entities of kind=phone.
      const digits = jid.split("@")[0]?.replace(/\D/g, "") ?? "";
      const redacted = digits.length >= 4 ? `…${digits.slice(-4)}` : digits;
      const stamp = a.last_linked_at_ms ?? Date.now();
      return {
        id:                  `${WA_ENTITY_PREFIX}${a.account_id}`,
        kind:                "phone" as const,
        display_name:        a.label,
        redacted_identifier: redacted,
        paired_at_ms:        stamp,
        last_seen_at_ms:     stamp,
      };
    });
}

type ChannelKind = "whatsapp" | "telegram" | "slack" | "mobile";

interface ChannelMeta {
  kind: ChannelKind;
  label: string;
  brand: string;
  icon: ReactNode;
  /** True when this channel supports desktop-side pairing today. */
  pairable: boolean;
  /** Helper copy for unpairable channels. */
  helper?: string;
  pairLabel?: string;
}

const CHANNELS: ChannelMeta[] = [
  {
    kind: "whatsapp",
    label: "WhatsApp",
    brand: "#25D366",
    icon: <WhatsAppGlyph />,
    pairable: true,
    pairLabel: "Pair new WhatsApp",
  },
  {
    kind: "telegram",
    label: "Telegram",
    brand: "#229ED9",
    icon: <TelegramGlyph />,
    pairable: false,
    helper:
      "Telegram is authenticated workspace-wide via your bot token. Configure under Settings → Notifications. Inbound conversations still mirror into the chat.",
  },
  {
    kind: "slack",
    label: "Slack",
    brand: "#4A154B",
    icon: <SlackGlyph />,
    pairable: false,
    helper:
      "Slack is authenticated via the workspace OAuth installation. Configure under Settings → Notifications. Inbound conversations still mirror into the chat.",
  },
  {
    kind: "mobile",
    label: "Mobile",
    brand: "var(--text-muted)",
    icon: <Smartphone size={13} strokeWidth={1.6} />,
    pairable: true,
    pairLabel: "Pair a new device",
  },
];

function entityKindForChannel(c: ChannelKind): PairedEntityDto["kind"] | null {
  if (c === "whatsapp") return "phone";
  if (c === "mobile") return "device";
  return null;
}

export function SettingsChannels() {
  const [paired, setPaired] = useState<PairedEntityDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ChannelKind>("whatsapp");

  const [pending, setPending] = useState<PendingPairingDto | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [sasState, setSasState] = useState<SasPendingState | null>(null);
  const [sasOpen, setSasOpen] = useState(false);
  const [mobileChallengeId, setMobileChallengeId] = useState<string | null>(null);

  // WhatsApp pair flow (Baileys, separate from the SAS primitive). The
  // sidecar emits `whatsapp:qr-update` until the user scans, then
  // `whatsapp:linked` when the WhatsApp side accepts.
  const [waPairingFor, setWaPairingFor] = useState<string | null>(null);
  const [waQr, setWaQr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Merge the SAS pairing list with the WhatsApp Baileys accounts.
      // The two backends are intentional siblings (S5 Baileys + S8 SAS)
      // and we don't want to force one to mirror the other; the UI is
      // the merge point.
      const [sasEntities, waAccountsRaw] = await Promise.all([
        pairingList(),
        invoke<WhatsAppAccountInfo[]>("whatsapp_list_accounts").catch((): WhatsAppAccountInfo[] => []),
      ]);
      const waEntities = whatsAppAccountsToEntities(waAccountsRaw);
      setPaired([...sasEntities, ...waEntities]);
      setError(null);
    } catch (e) {
      setError(errorToString(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const unlistenP = Promise.resolve(
      listen<SasPendingState>("messenger:sas-pending", (event) => {
        if (cancelled) return;
        setSasState(event.payload);
        setSasOpen(true);
      }),
    );
    return () => {
      cancelled = true;
      void unlistenP
        .then((fn: UnlistenFn | void) => {
          if (typeof fn === "function") fn();
        })
        .catch(() => undefined);
    };
  }, []);

  // WhatsApp Baileys events. `qr-update` ticks every ~20s until scan;
  // `linked` fires once on success. `logged-out` covers revoke from
  // the phone side. `connection-state-changed` keeps the merged list
  // current for things like reconnect.
  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<Promise<UnlistenFn>> = [
      listen<WhatsAppQrUpdateEvent>("whatsapp:qr-update", (event) => {
        if (cancelled) return;
        if (event.payload.account_id === waPairingFor) {
          setWaQr(event.payload.qr);
        }
        void refresh();
      }),
      listen<WhatsAppLinkedEvent>("whatsapp:linked", () => {
        if (cancelled) return;
        // Pair succeeded — close modal, drop the QR, refresh so the
        // newly-linked phone shows up in the merged list.
        setWaPairingFor(null);
        setWaQr(null);
        void refresh();
      }),
      listen("whatsapp:logged-out", () => {
        if (cancelled) return;
        void refresh();
      }),
      listen("whatsapp:connection-state-changed", () => {
        if (cancelled) return;
        void refresh();
      }),
    ];
    return () => {
      cancelled = true;
      unlistenFns.forEach((p) => p.then((fn) => fn()).catch(() => undefined));
    };
  }, [waPairingFor, refresh]);

  const startPairing = useCallback(async () => {
    try {
      if (active === "whatsapp") {
        // Baileys pair — opens the QR dialog. The actual QR arrives
        // asynchronously via the `whatsapp:qr-update` event and we
        // render it in the WhatsAppPairDialog.
        const accountId = `account-${Date.now().toString(36)}`;
        const stamp = new Date().toLocaleDateString();
        setWaPairingFor(accountId);
        setWaQr(null);
        setError(null);
        try {
          await invoke("whatsapp_login_start", {
            accountId,
            label: `Personal (${stamp})`,
          });
        } catch (e) {
          setWaPairingFor(null);
          throw e;
        }
      } else if (active === "mobile") {
        const fresh = await mobilePairingGenerate();
        setPending({
          id: fresh.challenge_id,
          code: fresh.code,
          code_chunked: fresh.code_chunked,
          kind: "device",
          created_at_ms: fresh.created_at_ms,
          expires_at_ms: fresh.expires_at_ms,
        });
        setMobileChallengeId(fresh.challenge_id);
        setPairingOpen(true);
        setError(null);
      }
    } catch (e) {
      setError(errorToString(e));
    }
  }, [active]);

  const handleRevoke = useCallback(
    async (entityId: string) => {
      try {
        // WhatsApp accounts ride a separate backend; the `wa:` prefix
        // on the synthetic entity ID is the source-of-record bit.
        if (entityId.startsWith(WA_ENTITY_PREFIX)) {
          const accountId = entityId.slice(WA_ENTITY_PREFIX.length);
          await invoke("whatsapp_logout", { accountId });
        } else {
          await pairingRevoke(entityId);
        }
        await refresh();
      } catch (e) {
        setError(errorToString(e));
      }
    },
    [refresh],
  );

  const handleSasMatch = useCallback(
    async (challengeId: string) => {
      try {
        if (mobileChallengeId && challengeId === mobileChallengeId) {
          await mobilePairingConfirm(challengeId, true);
          setMobileChallengeId(null);
        } else {
          await pairingConfirm(challengeId, true);
        }
        setSasOpen(false);
        setSasState(null);
        await refresh();
      } catch (e) {
        setError(errorToString(e));
      }
    },
    [refresh, mobileChallengeId],
  );

  const handleSasReject = useCallback(
    async (challengeId: string) => {
      try {
        if (mobileChallengeId && challengeId === mobileChallengeId) {
          await mobilePairingConfirm(challengeId, false);
          setMobileChallengeId(null);
        } else {
          await pairingConfirm(challengeId, false);
        }
      } catch {
        /* ignore */
      }
      setSasOpen(false);
      setSasState(null);
    },
    [mobileChallengeId],
  );

  const counts = useMemo(() => {
    const out: Record<ChannelKind, number> = {
      whatsapp: 0,
      telegram: 0,
      slack: 0,
      mobile: 0,
    };
    for (const e of paired) {
      if (e.kind === "phone") out.whatsapp += 1;
      if (e.kind === "device") out.mobile += 1;
    }
    return out;
  }, [paired]);

  const activeMeta = CHANNELS.find((c) => c.kind === active)!;
  const activeKindFilter = entityKindForChannel(active);
  const activeEntities =
    activeKindFilter !== null
      ? paired.filter((e) => e.kind === activeKindFilter)
      : [];

  return (
    <section data-testid="settings-section-channels" className="flex flex-col gap-5">
      <header>
        <h2
          className="text-[22px] font-light tracking-[-0.018em]"
          style={{ color: "var(--text)" }}
        >
          Channels
        </h2>
        <p className="text-[13px] mt-1.5" style={{ color: "var(--text-subtle)" }}>
          Where Inari can reach you, and what's bound to each delivery target.
        </p>
      </header>

      {error ? (
        <div
          data-testid="channels-error"
          className="text-[12.5px] rounded-[8px] px-3 py-2"
          style={{
            border: "1px solid rgba(208,133,133,0.4)",
            background: "rgba(208,133,133,0.05)",
            color: "var(--danger)",
          }}
        >
          {error}
        </div>
      ) : null}

      {/* Channel-tab picker */}
      <div
        className="flex items-center gap-1.5 p-1.5 rounded-[10px] flex-wrap"
        style={{
          background: "rgba(255,255,255,0.018)",
          border: "1px solid var(--border)",
        }}
        role="tablist"
        aria-label="Channel kind"
      >
        {CHANNELS.map((c) => {
          const isActive = c.kind === active;
          const count = counts[c.kind];
          return (
            <button
              key={c.kind}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-testid={`channel-tab-${c.kind}`}
              onClick={() => setActive(c.kind)}
              className="inline-flex items-center gap-2 transition-colors"
              style={{
                height: 32,
                padding: "0 11px",
                borderRadius: 8,
                background: isActive ? "rgba(255,255,255,0.05)" : "transparent",
                color: isActive ? "var(--text)" : "var(--text-muted)",
                border: isActive ? "1px solid var(--border-strong)" : "1px solid transparent",
                fontSize: 13,
              }}
            >
              <span style={{ color: isActive ? c.brand : "var(--text-subtle)" }}>
                {c.icon}
              </span>
              {c.label}
              <span
                className="text-[10.5px]"
                style={{
                  fontFamily: "var(--font-mono)",
                  color: count > 0 ? "var(--verified)" : "var(--text-faint)",
                }}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Active channel content */}
      {activeMeta.pairable ? (
        <PairedList
          entities={activeEntities}
          onRevoke={handleRevoke}
          channel={activeMeta}
        />
      ) : (
        <UnpairableHelper meta={activeMeta} />
      )}

      {activeMeta.pairable ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid={`channel-pair-${active}`}
            onClick={() => void startPairing()}
            className="h-9 px-3.5 rounded-lg text-[12.5px] font-medium flex items-center gap-2 transition-transform active:scale-[0.98]"
            style={{
              background: "var(--accent)",
              color: "var(--accent-ink)",
              border: "1px solid rgba(0,0,0,0.18)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 0 rgba(0,0,0,0.45)",
            }}
          >
            <Plus size={12} strokeWidth={2} />
            {activeMeta.pairLabel}
          </button>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 text-[12px] hover:text-[var(--text)] transition-colors"
            style={{ color: "var(--text-subtle)" }}
          >
            Show pairing log
            <ArrowRight size={11} strokeWidth={1.7} style={{ color: "var(--text-faint)" }} />
          </button>
        </div>
      ) : null}

      <PairingCodeModal
        open={pairingOpen}
        pending={pending}
        onOpenChange={setPairingOpen}
      />
      <SasConfirmModal
        open={sasOpen}
        state={sasState}
        onMatch={handleSasMatch}
        onReject={handleSasReject}
        onOpenChange={setSasOpen}
      />
      <WhatsAppPairDialog
        open={waPairingFor !== null}
        qr={waQr}
        onOpenChange={(open) => {
          if (!open) {
            // Dismissing the modal leaves the sidecar session running
            // — the qr_pending account is silently dropped on next
            // refresh by the connected/reconnecting filter.
            setWaPairingFor(null);
            setWaQr(null);
          }
        }}
      />
    </section>
  );
}

interface PairedListProps {
  entities: PairedEntityDto[];
  onRevoke: (entityId: string) => void | Promise<void>;
  channel: ChannelMeta;
}

function PairedList({ entities, onRevoke, channel }: PairedListProps) {
  if (entities.length === 0) {
    return (
      <div
        className="rounded-[10px] px-4 py-6 text-center"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
        }}
      >
        <div
          className="text-[13px]"
          style={{ color: "var(--text-muted)" }}
        >
          No {channel.label} paired yet.
        </div>
        <div
          className="text-[11.5px] mt-1.5"
          style={{ color: "var(--text-subtle)" }}
        >
          Click <span style={{ color: "var(--text-muted)" }}>{channel.pairLabel}</span>{" "}
          below — Inari signs every paired entity with a Witness receipt.
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-[10px] overflow-hidden"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
      }}
    >
      {entities.map((entity, idx) => (
        <PairRow
          key={entity.id}
          entity={entity}
          onRevoke={onRevoke}
          isLast={idx === entities.length - 1}
        />
      ))}
    </div>
  );
}

interface PairRowProps {
  entity: PairedEntityDto;
  onRevoke: (entityId: string) => void | Promise<void>;
  isLast: boolean;
}

function PairRow({ entity, onRevoke, isLast }: PairRowProps) {
  const witnessShort = deriveWitnessShort(entity.id);
  const age = formatAge(entity.paired_at_ms);
  return (
    <div
      data-testid={`paired-entity-${entity.id}`}
      className="flex items-center gap-3 px-4 py-3"
      style={{
        borderBottom: isLast ? "none" : "1px solid var(--border)",
      }}
    >
      <div
        className="flex items-center justify-center shrink-0"
        style={{
          width: 32,
          height: 32,
          borderRadius: 999,
          background: "rgba(255,255,255,0.025)",
          color: "var(--text-subtle)",
        }}
      >
        <PersonGlyph />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="text-[13px] truncate"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}
        >
          {entity.display_name || entity.id}
        </div>
        <div
          className="text-[11.5px] mt-0.5 truncate"
          style={{ color: "var(--text-subtle)" }}
        >
          {entity.kind === "phone"
            ? `WhatsApp DM · ${entity.redacted_identifier}`
            : entity.kind === "device"
              ? `Mobile device · ${entity.redacted_identifier}`
              : entity.redacted_identifier}
        </div>
      </div>
      <span
        className="inline-flex items-center gap-1.5 shrink-0"
        style={{
          height: 22,
          padding: "0 8px 0 7px",
          borderRadius: 999,
          background:
            "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))",
          border: "1px solid rgba(166,194,176,0.18)",
          color: "var(--verified)",
          fontSize: 11,
          lineHeight: 1,
        }}
      >
        <KeyRound size={11} strokeWidth={1.6} />
        <span style={{ color: "rgba(166,194,176,0.78)" }}>verified</span>
        <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            color: "#C8DDD0",
            letterSpacing: "0.01em",
          }}
        >
          {witnessShort}
        </span>
      </span>
      <span
        className="text-[10.5px] shrink-0"
        style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
      >
        paired {age}
      </span>
      <button
        type="button"
        onClick={() => void onRevoke(entity.id)}
        aria-label={`Revoke ${entity.display_name}`}
        data-testid={`paired-revoke-${entity.id}`}
        className="shrink-0 transition-colors hover:text-[var(--text)]"
        style={{ color: "var(--text-faint)", padding: 4 }}
      >
        <MoreHorizontal size={14} strokeWidth={1.7} />
      </button>
    </div>
  );
}

function UnpairableHelper({ meta }: { meta: ChannelMeta }) {
  return (
    <div
      className="rounded-[10px] px-4 py-4"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        className="text-[13px]"
        style={{ color: "var(--text-muted)" }}
      >
        {meta.label} setup
      </div>
      <p
        className="text-[12px] mt-1.5 leading-[1.55]"
        style={{ color: "var(--text-subtle)" }}
      >
        {meta.helper}
      </p>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function deriveWitnessShort(id: string): string {
  const stripped = id.replace(/[^a-z0-9]/gi, "").slice(0, 7).toLowerCase();
  return `w_${stripped}`;
}

function formatAge(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function WhatsAppGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3.7-7.3L21 4l-1.2 4.2A9 9 0 0 1 21 12z" />
      <path d="M8 11.5c0 2.5 2 4.5 4.5 4.5l1-1c-.6-.3-1.3-.6-1.7-1-.6-.5-1-1.2-1-1.8l.7-.7-1.2-2.3-1.3.5z" />
    </svg>
  );
}

function TelegramGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 4L3 11l5 2 2 5 4-3 4 3z" />
      <path d="M8 13l8-5" />
    </svg>
  );
}

function SlackGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="9" width="6" height="6" rx="1" />
      <rect x="14" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="4" width="6" height="6" rx="1" />
      <rect x="9" y="14" width="6" height="6" rx="1" />
    </svg>
  );
}

function PersonGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="9" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}
