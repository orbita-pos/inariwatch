/**
 * Phase 5.2 — contact entity provider tests.
 *
 * Stubs the paired-WhatsApp IPC via the `deps.list` injection point
 * and asserts the boundary mapping (`WhatsAppPaired` → `ContactEntity`).
 * We don't reach into the real Tauri runtime — the listPairedWhatsApp
 * production swallows errors on missing-IPC by design.
 */
import { describe, expect, it, vi } from "vitest";

import {
  listContacts,
  toContactEntity,
} from "../contacts";
import type { WhatsAppPaired } from "../../../whatsapp-recipient";

const paired = (over: Partial<WhatsAppPaired> = {}): WhatsAppPaired => ({
  entity_id: "e-1",
  display_name: "Jose",
  phone: "+5215512345678",
  redacted: "+52 ••••5678",
  ...over,
});

describe("toContactEntity()", () => {
  it("maps phone → jid, display_name → name, redacted → redacted", () => {
    const entity = toContactEntity(
      paired({
        display_name: "Mom",
        phone: "+1234567890",
        redacted: "+1 •••7890",
      }),
    );
    expect(entity).toEqual({
      jid: "+1234567890",
      name: "Mom",
      redacted: "+1 •••7890",
    });
  });
});

describe("listContacts()", () => {
  it("returns an empty array when the IPC stub returns []", async () => {
    const list = vi.fn(async () => [] as WhatsAppPaired[]);
    const result = await listContacts({ list });
    expect(result).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("maps every paired row through `toContactEntity`", async () => {
    const list = vi.fn(async () => [
      paired({ display_name: "Jose", phone: "+1" }),
      paired({ display_name: "Mom", phone: "+2" }),
    ]);
    const result = await listContacts({ list });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ jid: "+1", name: "Jose" });
    expect(result[1]).toMatchObject({ jid: "+2", name: "Mom" });
  });

  it("preserves the source ordering", async () => {
    // Picker relies on the IPC's order — recency / pairing order.
    // We don't sort here, so the provider must pass through.
    const list = vi.fn(async () => [
      paired({ display_name: "B", phone: "+2" }),
      paired({ display_name: "A", phone: "+1" }),
    ]);
    const result = await listContacts({ list });
    expect(result.map((c) => c.name)).toEqual(["B", "A"]);
  });
});
