/**
 * Fase 5 — execute_plan tool gating tests.
 *
 * Pins the contract from arch doc §4 Fase 5 line 418:
 *   "initially behind flag CODEACT_ENABLED, only available from turn 3+"
 *
 * Pure unit tests — no Deno, no DB, no container. Asserts buildToolsForTurn()
 * returns the right tool list per (flag, turn) combination so the model
 * cannot see execute_plan when it isn't supposed to.
 */

import { describe, it, beforeEach, afterEach, before } from "node:test";
import assert from "node:assert/strict";

const ORIGINAL_FLAG = process.env.CODEACT_ENABLED;
const ORIGINAL_DB_URL = process.env.DATABASE_URL;

if (!ORIGINAL_DB_URL) {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
}

function setFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.CODEACT_ENABLED;
  else process.env.CODEACT_ENABLED = value;
}

describe("isCodeActEnabled", () => {
  let isCodeActEnabled: typeof import("../container-agent.js").isCodeActEnabled;

  before(async () => {
    const mod = await import("../container-agent.js");
    isCodeActEnabled = mod.isCodeActEnabled;
  });
  beforeEach(() => setFlag(undefined));
  afterEach(() => setFlag(ORIGINAL_FLAG));

  it("returns false when unset", () => {
    assert.equal(isCodeActEnabled(), false);
  });
  it("returns false when 'false'", () => {
    setFlag("false");
    assert.equal(isCodeActEnabled(), false);
  });
  it("returns false for non-canonical truthy values ('1', 'yes', 'TRUE')", () => {
    for (const v of ["1", "yes", "TRUE", "True"]) {
      setFlag(v);
      assert.equal(isCodeActEnabled(), false, `value=${v}`);
    }
  });
  it("returns true ONLY for the literal string 'true'", () => {
    setFlag("true");
    assert.equal(isCodeActEnabled(), true);
  });
});

describe("buildToolsForTurn — execute_plan gating", () => {
  let buildToolsForTurn: typeof import("../container-agent.js").buildToolsForTurn;

  before(async () => {
    const mod = await import("../container-agent.js");
    buildToolsForTurn = mod.buildToolsForTurn;
  });
  afterEach(() => setFlag(ORIGINAL_FLAG));

  it("does NOT include execute_plan when CODEACT_ENABLED is off, regardless of turn", () => {
    setFlag("false");
    for (const turn of [1, 2, 3, 5, 20, 40]) {
      const tools = buildToolsForTurn(turn);
      assert.equal(
        tools.some((t) => t.name === "execute_plan"),
        false,
        `turn=${turn} should not have execute_plan when flag is off`,
      );
    }
  });

  it("does NOT include execute_plan on turns 1 and 2 even when flag is on", () => {
    setFlag("true");
    for (const turn of [1, 2]) {
      const tools = buildToolsForTurn(turn);
      assert.equal(
        tools.some((t) => t.name === "execute_plan"),
        false,
        `turn=${turn} is below the min-turn floor`,
      );
    }
  });

  it("INCLUDES execute_plan on turn >= 3 when flag is on", () => {
    setFlag("true");
    for (const turn of [3, 5, 20, 40]) {
      const tools = buildToolsForTurn(turn);
      assert.equal(
        tools.some((t) => t.name === "execute_plan"),
        true,
        `turn=${turn} should have execute_plan when flag is on`,
      );
    }
  });

  it("preserves the existing 8-tool list (no removals) on every turn", () => {
    setFlag("true");
    const expected = [
      "read_file", "search_code", "list_directory", "think",
      "apply_patch", "write_file", "run_command", "submit_fix",
    ];
    for (const turn of [1, 3, 40]) {
      const names = buildToolsForTurn(turn).map((t) => t.name);
      for (const e of expected) {
        assert.ok(names.includes(e), `turn=${turn} missing tool ${e}`);
      }
    }
  });

  it("execute_plan tool schema matches GPT54 §B4 (code + purpose required, strict)", () => {
    setFlag("true");
    const tools = buildToolsForTurn(3);
    const ep = tools.find((t) => t.name === "execute_plan")!;
    assert.ok(ep, "execute_plan must be present");
    const schema = ep.input_schema as { properties?: Record<string, unknown>; required?: string[] };
    assert.deepEqual(schema.required?.slice().sort(), ["code", "purpose"]);
    assert.ok(schema.properties?.code, "code property required");
    assert.ok(schema.properties?.purpose, "purpose property required");
  });
});
