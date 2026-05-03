/**
 * Code Intelligence v2 — Phase 3.1
 * Migration 0082 shape test. Mirrors the migration-0077 / 0080 style.
 *
 * Renumbered from 0081 → 0082 during v0.3 integration merge — S5
 * (workspace_local_voice) had already taken slot 0081 on origin/main.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "migrations",
  "0082_code_intel_v2_shadow_controls.sql",
);

const SQL = readFileSync(MIGRATION_PATH, "utf8");

const SQL_NO_COMMENTS = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

describe("migration 0082 — code intel v2 shadow controls", () => {
  it("adds organizations.code_intel_v2_shadow_pct as nullable smallint", () => {
    expect(SQL).toMatch(
      /ALTER TABLE\s+"organizations"[\s\S]*?ADD COLUMN IF NOT EXISTS\s+"code_intel_v2_shadow_pct"\s+(?:smallint|integer)/i,
    );
  });

  it("constrains shadow_pct to NULL or 0..100", () => {
    expect(SQL).toMatch(
      /CHECK\s*\(\s*"code_intel_v2_shadow_pct"\s+IS\s+NULL\s+OR\s*\(\s*"code_intel_v2_shadow_pct"\s+BETWEEN\s+0\s+AND\s+100/i,
    );
  });

  it("adds code_intel_shadow_log.v2_timed_out as NOT NULL DEFAULT false", () => {
    expect(SQL).toMatch(
      /ALTER TABLE\s+"code_intel_shadow_log"[\s\S]*?ADD COLUMN IF NOT EXISTS\s+"v2_timed_out"\s+boolean\s+NOT NULL\s+DEFAULT\s+false/i,
    );
  });

  it("uses ADD COLUMN IF NOT EXISTS for both ALTERs (re-run safe)", () => {
    const adds = SQL_NO_COMMENTS.match(/ADD COLUMN[^\n;]+/gi) ?? [];
    expect(adds.length).toBe(2);
    for (const a of adds) expect(a).toMatch(/IF NOT EXISTS/i);
  });

  it("comments both columns with the Phase 3.1 rationale", () => {
    expect(SQL).toMatch(/COMMENT ON COLUMN\s+"organizations"\."code_intel_v2_shadow_pct"/i);
    expect(SQL).toMatch(/COMMENT ON COLUMN\s+"code_intel_shadow_log"\."v2_timed_out"/i);
    expect(SQL).toMatch(/SHADOW_SAMPLE_RATE/);
  });

  it("documents the rollback statement", () => {
    expect(SQL).toMatch(/Rollback[\s\S]*?DROP COLUMN IF EXISTS\s+"?code_intel_v2_shadow_pct"?/i);
    expect(SQL).toMatch(/DROP COLUMN IF EXISTS\s+"?v2_timed_out"?/i);
  });

  it("does not modify any other table or drop anything", () => {
    const alters = SQL_NO_COMMENTS.match(/ALTER TABLE\s+"([^"]+)"/gi) ?? [];
    expect(alters.length).toBe(2);
    expect(alters.some((a) => /organizations/i.test(a))).toBe(true);
    expect(alters.some((a) => /code_intel_shadow_log/i.test(a))).toBe(true);
    expect(SQL_NO_COMMENTS).not.toMatch(/DROP TABLE/i);
    expect(SQL_NO_COMMENTS).not.toMatch(/DROP COLUMN(?!\s+IF EXISTS)/i);
  });

  it("only adds (does not redefine) — no CREATE TABLE", () => {
    expect(SQL_NO_COMMENTS).not.toMatch(/CREATE TABLE/i);
  });
});
