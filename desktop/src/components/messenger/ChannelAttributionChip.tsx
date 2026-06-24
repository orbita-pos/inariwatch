/**
 * Channel attribution chip — rendered next to a `ChatMessage` whose
 * `source` indicates the message arrived via WhatsApp / Telegram /
 * Slack rather than the dock's local conversation.
 *
 * The redacted identifier is what the backend sends — never the raw
 * phone. The chip is decorative + a hover affordance only; clicks are
 * not routed (clicks on the underlying message bubble take the user to
 * the dock chat surface as usual).
 */

import { type ReactNode } from "react";

export type MessengerSource =
  | { kind: "dock" }
  | {
      kind: "messenger";
      channel: "whatsapp" | "telegram" | "slack";
      paired_id: string;
      redacted_identifier: string;
      display_name: string;
    };

export function isMessengerSource(
  source: MessengerSource | undefined,
): source is Extract<MessengerSource, { kind: "messenger" }> {
  return !!source && source.kind === "messenger";
}

const CHANNEL_LABEL: Record<"whatsapp" | "telegram" | "slack", string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  slack: "Slack",
};

const CHANNEL_ICON: Record<"whatsapp" | "telegram" | "slack", ReactNode> = {
  whatsapp: <span aria-hidden>💬</span>,
  telegram: <span aria-hidden>✈️</span>,
  slack: <span aria-hidden>#</span>,
};

export interface ChannelAttributionChipProps {
  source: MessengerSource;
  className?: string;
}

export function ChannelAttributionChip({
  source,
  className,
}: ChannelAttributionChipProps) {
  if (!isMessengerSource(source)) return null;
  const label = CHANNEL_LABEL[source.channel];
  return (
    <span
      data-testid={`channel-chip-${source.channel}`}
      className={[
        "inline-flex items-center gap-1 px-1.5 h-5 rounded-[var(--radius-sm)]",
        "border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)]",
        "text-[11px] font-medium",
        className ?? "",
      ].join(" ")}
      title={`${source.display_name} · ${source.redacted_identifier}`}
    >
      {CHANNEL_ICON[source.channel]}
      <span>{label}</span>
      <span className="text-[var(--text)]">·</span>
      <span>{source.redacted_identifier}</span>
    </span>
  );
}
