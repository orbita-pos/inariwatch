import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PairedEntityList } from "@/components/pairing/PairedEntityList";
import type { PairedEntityDto } from "@/lib/main-ipc";

const FIXTURE: PairedEntityDto[] = [
  {
    id: "ent-1",
    kind: "phone",
    display_name: "Jesus Phone",
    redacted_identifier: "+52 ••••5678",
    paired_at_ms: Date.now() - 60_000,
    last_seen_at_ms: Date.now(),
  },
  {
    id: "ent-2",
    kind: "phone",
    display_name: "Work Line",
    redacted_identifier: "+1 ••••1234",
    paired_at_ms: Date.now() - 86_400_000,
    last_seen_at_ms: Date.now(),
  },
];

describe("PairedEntityList", () => {
  it("renders empty state when no entities", () => {
    render(<PairedEntityList entities={[]} onRevoke={() => undefined} />);
    expect(screen.getByTestId("paired-empty")).toBeInTheDocument();
  });

  it("renders one row per entity with the redacted identifier", () => {
    render(<PairedEntityList entities={FIXTURE} onRevoke={() => undefined} />);
    expect(screen.getByTestId("paired-entity-ent-1").textContent).toContain(
      "Jesus Phone",
    );
    expect(screen.getByTestId("paired-entity-ent-1").textContent).toContain(
      "+52 ••••5678",
    );
    expect(screen.getByTestId("paired-entity-ent-2")).toBeInTheDocument();
  });

  it("Revoke button dispatches onRevoke with entity id", () => {
    const onRevoke = vi.fn();
    render(<PairedEntityList entities={FIXTURE} onRevoke={onRevoke} />);
    screen.getByTestId("paired-revoke-ent-1").click();
    expect(onRevoke).toHaveBeenCalledWith("ent-1");
  });
});
