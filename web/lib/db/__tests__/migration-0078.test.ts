/**
 * Code Intelligence v2 — Phase 0.1
 * Migration 0078 shape test. Reads the SQL file and asserts the
 * column + index it introduces are present and backwards-compatible.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "migrations",
  "0078_code_chunks_embedding_version.sql"
);

const SQL = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0078 — code_chunks.embedding_model_version", () => {
  it("adds the column with NOT NULL DEFAULT 'voyage-code-3'", () => {
    expect(SQL).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+"embedding_model_version"\s+text\s+NOT NULL\s+DEFAULT\s+'voyage-code-3'/i
    );
  });

  it("creates the (repo_id, embedding_model_version) index", () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+"idx_code_chunks_embedding_model"\s+ON\s+"code_chunks"\s+\("repo_id",\s*"embedding_model_version"\)/i
    );
  });

  it("uses ADD COLUMN IF NOT EXISTS so re-running is safe", () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS/i);
  });

  it("uses CREATE INDEX IF NOT EXISTS so re-running is safe", () => {
    expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS/i);
  });

  it("does not drop, alter, or rename existing columns", () => {
    expect(SQL).not.toMatch(/DROP COLUMN/i);
    expect(SQL).not.toMatch(/RENAME COLUMN/i);
    expect(SQL).not.toMatch(/ALTER COLUMN/i);
  });
});
