/**
 * Code Intelligence v2 — Phase 3.2
 * Migration 0083 shape test. Mirrors the migration-0079 / 0080 / 0081 / 0082 style.
 *
 * Renumbered from 0082 → 0083 during v0.3 integration merge — Phase 3.1
 * (code_intel_v2_shadow_controls) had taken slot 0082 first.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "migrations",
  "0083_code_intel_remediation_ab.sql",
);

const SQL = readFileSync(MIGRATION_PATH, "utf8");

const SQL_NO_COMMENTS = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

describe("migration 0083 — code_intel_remediation_ab", () => {
  it("creates the table with IF NOT EXISTS", () => {
    expect(SQL).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+"code_intel_remediation_ab"/i,
    );
  });

  it("declares every required column", () => {
    const required = [
      ["id", /uuid\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)\s+NOT NULL/i],
      ["alert_id", /uuid\s+NOT NULL\s+REFERENCES\s+"alerts"/i],
      ["remediation_session_id", /uuid\s+REFERENCES\s+"remediation_sessions"/i],
      ["engine", /text\s+NOT NULL/i],
      ["workspace_pct", /integer/i],
      ["turn_count", /integer\s+NOT NULL/i],
      ["success", /boolean\s+NOT NULL/i],
      ["cost_usd", /numeric\(12,\s*6\)/i],
      ["duration_ms", /integer\s+NOT NULL/i],
      ["started_at", /timestamptz\s+NOT NULL/i],
      ["finished_at", /timestamptz\s+NOT NULL/i],
      ["failure_reason", /text/i],
      ["created_at", /timestamptz\s+NOT NULL\s+DEFAULT\s+now\(\)/i],
    ] as const;
    for (const [col, typePattern] of required) {
      const line = new RegExp(`"${col}"\\s+${typePattern.source}`, typePattern.flags);
      expect(SQL).toMatch(line);
    }
  });

  it("constrains engine to v1 | v2 via CHECK (no pg ENUM)", () => {
    expect(SQL).toMatch(
      /CONSTRAINT\s+"code_intel_remediation_ab_engine_chk"[\s\S]*?CHECK\s*\(\s*"engine"\s+IN\s*\(\s*'v1'\s*,\s*'v2'\s*\)/i,
    );
    expect(SQL_NO_COMMENTS).not.toMatch(/CREATE TYPE/i);
  });

  it("constrains workspace_pct to 0..100 (or NULL)", () => {
    expect(SQL).toMatch(
      /CHECK\s*\(\s*"workspace_pct"\s+IS\s+NULL\s+OR\s*\(\s*"workspace_pct"\s+BETWEEN\s+0\s+AND\s+100/i,
    );
  });

  it("cascades on alert deletion, sets null on session deletion", () => {
    expect(SQL).toMatch(
      /"alert_id"\s+uuid\s+NOT NULL\s+REFERENCES\s+"alerts"\("id"\)\s+ON DELETE CASCADE/i,
    );
    expect(SQL).toMatch(
      /"remediation_session_id"\s+uuid\s+REFERENCES\s+"remediation_sessions"\("id"\)\s+ON DELETE SET NULL/i,
    );
  });

  it("creates the three lookup indexes", () => {
    expect(SQL).toMatch(/idx_code_intel_remediation_ab_alert/i);
    expect(SQL).toMatch(/idx_code_intel_remediation_ab_engine_created/i);
    expect(SQL).toMatch(/idx_code_intel_remediation_ab_session/i);
  });

  it("guards every CREATE TABLE / CREATE INDEX with IF NOT EXISTS", () => {
    const tables = SQL_NO_COMMENTS.match(/CREATE TABLE[^\n]+/g) ?? [];
    expect(tables.length).toBe(1);
    for (const t of tables) expect(t).toMatch(/IF NOT EXISTS/);

    const indexes = SQL_NO_COMMENTS.match(/CREATE INDEX[^\n]+/g) ?? [];
    expect(indexes.length).toBe(3);
    for (const i of indexes) expect(i).toMatch(/IF NOT EXISTS/);
  });

  it("adds organizations.code_intel_v2_agent_ab_pct (additive, with CHECK)", () => {
    expect(SQL).toMatch(
      /ALTER TABLE\s+"organizations"[\s\S]*?ADD COLUMN IF NOT EXISTS\s+"code_intel_v2_agent_ab_pct"\s+integer/i,
    );
    expect(SQL).toMatch(
      /CHECK\s*\(\s*"code_intel_v2_agent_ab_pct"\s+IS\s+NULL\s+OR\s*\(\s*"code_intel_v2_agent_ab_pct"\s+BETWEEN\s+0\s+AND\s+100/i,
    );
  });

  it("documents the rollback statements for both objects", () => {
    expect(SQL).toMatch(/Rollback[\s\S]*?DROP COLUMN IF EXISTS\s+"?code_intel_v2_agent_ab_pct"?/i);
    expect(SQL).toMatch(/DROP TABLE IF EXISTS\s+"?code_intel_remediation_ab"?/i);
  });

  it("does not drop or modify any table outside the two it owns", () => {
    const alters = SQL_NO_COMMENTS.match(/ALTER TABLE\s+"([^"]+)"/gi) ?? [];
    expect(alters.length).toBe(1);
    expect(alters[0]).toMatch(/organizations/i);
    expect(SQL_NO_COMMENTS).not.toMatch(/DROP TABLE/i);
  });
});
