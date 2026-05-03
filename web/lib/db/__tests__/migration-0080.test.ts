/**
 * Code Intelligence v2 — Phase 1.5
 * Migration 0080 shape test. Mirrors migration-0078/0079 style.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "migrations",
  "0080_code_intel_shadow_log.sql"
);

const SQL = readFileSync(MIGRATION_PATH, "utf8");

const SQL_NO_COMMENTS = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

describe("migration 0080 — code_intel_shadow_log", () => {
  it("creates the table with IF NOT EXISTS", () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS\s+"code_intel_shadow_log"/i);
  });

  it("declares every required column", () => {
    const required = [
      ["id", /uuid\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)\s+NOT NULL/i],
      ["repo_id", /uuid\s+REFERENCES\s+"code_repositories"/i],
      ["project_id", /uuid/i],
      ["query", /text\s+NOT NULL/i],
      ["v1_result_count", /integer\s+NOT NULL/i],
      ["v2_result_count", /integer\s+NOT NULL/i],
      ["v1_top_fqns", /jsonb\s+NOT NULL\s+DEFAULT\s+'\[\]'::jsonb/i],
      ["v2_top_fqns", /jsonb\s+NOT NULL\s+DEFAULT\s+'\[\]'::jsonb/i],
      ["v1_duration_ms", /integer\s+NOT NULL/i],
      ["v2_duration_ms", /integer\s+NOT NULL/i],
      ["v1_error", /text/i],
      ["v2_error", /text/i],
      ["created_at", /timestamptz\s+NOT NULL\s+DEFAULT\s+now\(\)/i],
    ] as const;
    for (const [col, typePattern] of required) {
      const line = new RegExp(`"${col}"\\s+${typePattern.source}`, typePattern.flags);
      expect(SQL).toMatch(line);
    }
  });

  it("cascades on repo deletion", () => {
    expect(SQL).toMatch(
      /"repo_id"\s+uuid\s+REFERENCES\s+"code_repositories"\("id"\)\s+ON DELETE CASCADE/i
    );
  });

  it("creates the (repo_id, created_at DESC) index", () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+"idx_code_intel_shadow_repo_created"\s+ON\s+"code_intel_shadow_log"\s+\(\s*"repo_id"\s*,\s*"created_at"\s+DESC\s*\)/i
    );
  });

  it("creates the (project_id, created_at DESC) index", () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+"idx_code_intel_shadow_project_created"\s+ON\s+"code_intel_shadow_log"\s+\(\s*"project_id"\s*,\s*"created_at"\s+DESC\s*\)/i
    );
  });

  it("guards every CREATE TABLE / CREATE INDEX with IF NOT EXISTS", () => {
    const tables = SQL_NO_COMMENTS.match(/CREATE TABLE[^\n]+/g) ?? [];
    expect(tables.length).toBe(1);
    for (const t of tables) expect(t).toMatch(/IF NOT EXISTS/);

    const indexes = SQL_NO_COMMENTS.match(/CREATE INDEX[^\n]+/g) ?? [];
    expect(indexes.length).toBe(2);
    for (const i of indexes) expect(i).toMatch(/IF NOT EXISTS/);
  });

  it("does not modify any other table", () => {
    expect(SQL_NO_COMMENTS).not.toMatch(/ALTER TABLE/i);
    expect(SQL_NO_COMMENTS).not.toMatch(/DROP TABLE/i);
    expect(SQL_NO_COMMENTS).not.toMatch(/DROP COLUMN/i);
  });
});
