import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ChannelAttributionChip,
  isMessengerSource,
  type MessengerSource,
} from "@/components/messenger/ChannelAttributionChip";

describe("ChannelAttributionChip", () => {
  it("renders WhatsApp chip with redacted identifier", () => {
    const source: MessengerSource = {
      kind: "messenger",
      channel: "whatsapp",
      paired_id: "ent-123",
      redacted_identifier: "+52 ••••5678",
      display_name: "Jesus",
    };
    render(<ChannelAttributionChip source={source} />);
    const chip = screen.getByTestId("channel-chip-whatsapp");
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toContain("WhatsApp");
    expect(chip.textContent).toContain("+52 ••••5678");
  });

  it("renders nothing for dock-source messages", () => {
    render(<ChannelAttributionChip source={{ kind: "dock" }} />);
    expect(screen.queryByTestId("channel-chip-whatsapp")).toBeNull();
    expect(screen.queryByTestId("channel-chip-telegram")).toBeNull();
    expect(screen.queryByTestId("channel-chip-slack")).toBeNull();
  });

  it.each(["whatsapp", "telegram", "slack"] as const)(
    "renders the correct chip for %s",
    (channel) => {
      const source: MessengerSource = {
        kind: "messenger",
        channel,
        paired_id: "id",
        redacted_identifier: "@user",
        display_name: "User",
      };
      render(<ChannelAttributionChip source={source} />);
      expect(screen.getByTestId(`channel-chip-${channel}`)).toBeInTheDocument();
    },
  );

  it("isMessengerSource narrows correctly", () => {
    expect(isMessengerSource({ kind: "dock" })).toBe(false);
    expect(
      isMessengerSource({
        kind: "messenger",
        channel: "whatsapp",
        paired_id: "x",
        redacted_identifier: "+1",
        display_name: "X",
      }),
    ).toBe(true);
    expect(isMessengerSource(undefined)).toBe(false);
  });
});
