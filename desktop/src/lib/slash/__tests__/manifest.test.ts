/**
 * Drift test for the slash-command manifest.
 *
 * Phase 2 of the pure-slash refactor consumes `SLASH_MANIFEST` to drive
 * the AI autocomplete. The dispatch path is owned by `slash-catalog.ts`
 * + `slash-dispatch.ts` + `slash/handlers.ts`. This test locks the
 * invariant that every command reachable via the dispatcher is
 * advertised in the manifest, AND every manifest entry has a path that
 * actually runs.
 *
 * Drift here is silent in production — the autocomplete would just
 * stop suggesting the command — so the test failing on a missing entry
 * is the cheapest place to catch it.
 */

import { describe, expect, it } from "vitest";

import { SLASH_MANIFEST, findManifestEntry, serializeManifestForPrompt } from "../manifest";
import { SLASH_CATALOG, SLASH_META } from "../../slash-catalog";
import { STRUCTURED_HANDLERS } from "../handlers";

// Commands the dispatcher special-cases inline (not in catalog or
// STRUCTURED_HANDLERS). Mirrors the constants at the top of
// `slash-dispatch.ts` — kept in sync by hand because importing private
// sets would create a circular dep.
const DISPATCHER_SPECIAL_CASED = new Set([
  // META
  "help",
  "?",
  // GITHUB
  "github",
  "gh",
  // WHATSAPP
  "whatsapp",
  "wa",
  // TEST (Inari Guard)
  "test",
  // Simple meta handlers
  "new",
  "clear",
  "settings",
  "audit",
  "devices",
  "theme",
  "voice",
  // Conversation lifecycle (require open conversation context)
  "snooze",
  "resolve",
  "reopen",
  "archive",
  "ack",
  "silence",
  "escalate",
  "summarize",
  "export",
  "witness",
]);

function stripSlash(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

describe("SLASH_MANIFEST shape", () => {
  it("every entry's name starts with `/`", () => {
    for (const entry of SLASH_MANIFEST) {
      expect(entry.name.startsWith("/")).toBe(true);
    }
  });

  it("every entry has at least one example", () => {
    for (const entry of SLASH_MANIFEST) {
      expect(entry.examples.length).toBeGreaterThan(0);
    }
  });

  it("entry names are unique", () => {
    const names = SLASH_MANIFEST.map((e) => e.name.toLowerCase());
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("enum args declare enumValues", () => {
    for (const entry of SLASH_MANIFEST) {
      for (const arg of entry.args) {
        if (arg.type === "enum") {
          expect(arg.enumValues, `${entry.name}#${arg.name}`).toBeDefined();
          expect(arg.enumValues?.length, `${entry.name}#${arg.name}`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("manifest ↔ dispatcher drift", () => {
  it("every manifest command has a dispatch path", () => {
    for (const entry of SLASH_MANIFEST) {
      const cmd = stripSlash(entry.name);
      const reachable =
        DISPATCHER_SPECIAL_CASED.has(cmd) ||
        SLASH_CATALOG.some((c) => c.command === cmd) ||
        Object.prototype.hasOwnProperty.call(STRUCTURED_HANDLERS, cmd);
      expect(reachable, `manifest entry \`${entry.name}\` has no dispatch path`).toBe(true);
    }
  });

  it("every catalog command is in the manifest", () => {
    for (const entry of SLASH_CATALOG) {
      const found = findManifestEntry(entry.command);
      expect(found, `catalog command \`${entry.command}\` missing from manifest`).not.toBeNull();
    }
  });

  it("every SLASH_META display entry is in the manifest", () => {
    for (const entry of SLASH_META) {
      const found = findManifestEntry(entry.command);
      expect(found, `meta entry \`${entry.command}\` missing from manifest`).not.toBeNull();
    }
  });

  it("every structured handler key is in the manifest", () => {
    for (const cmd of Object.keys(STRUCTURED_HANDLERS)) {
      const found = findManifestEntry(cmd);
      expect(found, `structured handler \`${cmd}\` missing from manifest`).not.toBeNull();
    }
  });
});

describe("findManifestEntry", () => {
  it("looks up commands with or without leading slash", () => {
    expect(findManifestEntry("/projects")?.name).toBe("/projects");
    expect(findManifestEntry("projects")?.name).toBe("/projects");
    expect(findManifestEntry("PROJECTS")?.name).toBe("/projects");
  });

  it("returns null for unknown commands", () => {
    expect(findManifestEntry("/nonexistent")).toBeNull();
  });
});

describe("serializeManifestForPrompt", () => {
  it("returns valid JSON listing every entry", () => {
    const json = serializeManifestForPrompt();
    const parsed = JSON.parse(json) as Array<{ name: string; description: string; args: unknown[] }>;
    expect(parsed.length).toBe(SLASH_MANIFEST.length);
    for (let i = 0; i < parsed.length; i++) {
      expect(parsed[i]?.name).toBe(SLASH_MANIFEST[i]?.name);
      expect(typeof parsed[i]?.description).toBe("string");
      expect(Array.isArray(parsed[i]?.args)).toBe(true);
    }
  });

  it("drops the tone field but keeps args metadata", () => {
    const json = serializeManifestForPrompt();
    expect(json).not.toMatch(/"tone"/);
    expect(json).toMatch(/"enumValues"/);
    expect(json).toMatch(/"required"/);
  });

  it("stays under 12K bytes — autocomplete prompt budget", () => {
    // The plan caps the manifest payload at ~3K tokens; ~4 chars/token
    // gives us a ~12 KB ceiling. Hard cap here so any future explosion
    // of new commands (or wordy descriptions) gets caught.
    const json = serializeManifestForPrompt();
    expect(json.length).toBeLessThan(12_000);
  });
});
