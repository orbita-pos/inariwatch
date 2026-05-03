/**
 * Code Intelligence v2 — Phase 1.1
 * Migration 0079 shape test. Reads the SQL file and asserts the four new
 * semantic-graph tables (code_symbols, code_references, code_type_facts,
 * code_imports), required columns, indexes, FK behavior, and idempotency
 * guards are all in place. Pure structural — does not run the migration
 * against a real database.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "migrations",
  "0079_code_intel_v2.sql"
);

const SQL = readFileSync(MIGRATION_PATH, "utf8");

// Stripped of `-- …` line comments. Used by the safety/idempotency assertions
// so that rollback notes and prose explanations in the header don't trip
// regexes like /DROP TABLE/ or the CREATE-TABLE counter.
const SQL_NO_COMMENTS = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

describe("migration 0079 — code intelligence v2 schema", () => {
  describe("code_symbols table", () => {
    it("creates the table with IF NOT EXISTS", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS\s+"code_symbols"/i);
    });

    it("declares every column from the handoff", () => {
      const required = [
        ["id", /uuid\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)\s+NOT NULL/i],
        ["repo_id", /uuid\s+NOT NULL\s+REFERENCES\s+"code_repositories"/i],
        ["fqn", /text\s+NOT NULL/i],
        ["kind", /text\s+NOT NULL/i],
        ["name", /text\s+NOT NULL/i],
        ["file_path", /text\s+NOT NULL/i],
        ["start_line", /integer\s+NOT NULL/i],
        ["end_line", /integer\s+NOT NULL/i],
        ["start_col", /integer/i],
        ["end_col", /integer/i],
        ["signature", /text/i],
        ["return_type", /text/i],
        ["is_async", /boolean\s+NOT NULL\s+DEFAULT\s+false/i],
        ["is_exported", /boolean\s+NOT NULL\s+DEFAULT\s+false/i],
        ["is_static", /boolean\s+NOT NULL\s+DEFAULT\s+false/i],
        ["is_abstract", /boolean\s+NOT NULL\s+DEFAULT\s+false/i],
        ["visibility", /text/i],
        ["doc_comment", /text/i],
        ["parent_id", /uuid\s+REFERENCES\s+"code_symbols"/i],
        ["language", /text\s+NOT NULL/i],
        ["ast_hash", /text\s+NOT NULL/i],
        ["indexed_at", /timestamptz\s+NOT NULL\s+DEFAULT\s+now\(\)/i],
      ] as const;
      for (const [col, typePattern] of required) {
        const line = new RegExp(`"${col}"\\s+${typePattern.source}`, typePattern.flags);
        expect(SQL).toMatch(line);
      }
    });

    it("cascades on repo deletion", () => {
      expect(SQL).toMatch(
        /"repo_id"\s+uuid\s+NOT NULL\s+REFERENCES\s+"code_repositories"\("id"\)\s+ON DELETE CASCADE/i
      );
    });

    it("cascades on parent symbol deletion (per-file cleanup safety)", () => {
      expect(SQL).toMatch(
        /"parent_id"\s+uuid\s+REFERENCES\s+"code_symbols"\("id"\)\s+ON DELETE CASCADE/i
      );
    });

    it("declares the UNIQUE (repo_id, fqn, kind) constraint for TS declaration merging", () => {
      expect(SQL).toMatch(
        /CONSTRAINT\s+"code_symbols_fqn_unique"\s+UNIQUE\s+\(\s*"repo_id"\s*,\s*"fqn"\s*,\s*"kind"\s*\)/i
      );
    });

    it("creates the (repo_id, kind) index", () => {
      expect(SQL).toMatch(
        /CREATE INDEX IF NOT EXISTS\s+"idx_code_symbols_repo_kind"\s+ON\s+"code_symbols"\s+\(\s*"repo_id"\s*,\s*"kind"\s*\)/i
      );
    });

    it("creates the (repo_id, file_path) index", () => {
      expect(SQL).toMatch(
        /CREATE INDEX IF NOT EXISTS\s+"idx_code_symbols_repo_file"\s+ON\s+"code_symbols"\s+\(\s*"repo_id"\s*,\s*"file_path"\s*\)/i
      );
    });

    it("creates the (repo_id, name) index", () => {
      expect(SQL).toMatch(
        /CREATE INDEX IF NOT EXISTS\s+"idx_code_symbols_name"\s+ON\s+"code_symbols"\s+\(\s*"repo_id"\s*,\s*"name"\s*\)/i
      );
    });
  });

  describe("code_references table", () => {
    it("creates the table with IF NOT EXISTS", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS\s+"code_references"/i);
    });

    it("declares every required column", () => {
      const required = [
        ["id", /uuid\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)\s+NOT NULL/i],
        ["repo_id", /uuid\s+NOT NULL\s+REFERENCES\s+"code_repositories"/i],
        ["target_symbol_id", /uuid\s+NOT NULL\s+REFERENCES\s+"code_symbols"/i],
        ["file_path", /text\s+NOT NULL/i],
        ["line", /integer\s+NOT NULL/i],
        ["col", /integer/i],
        ["kind", /text\s+NOT NULL/i],
      ] as const;
      for (const [col, typePattern] of required) {
        const line = new RegExp(`"${col}"\\s+${typePattern.source}`, typePattern.flags);
        expect(SQL).toMatch(line);
      }
    });

    it("makes source_symbol_id nullable (file-scope refs have no enclosing symbol)", () => {
      // Pattern: column declaration followed by REFERENCES, with no NOT NULL between them.
      expect(SQL).toMatch(
        /"source_symbol_id"\s+uuid\s+REFERENCES\s+"code_symbols"\("id"\)\s+ON DELETE CASCADE/i
      );
      // Defense: ensure we did NOT accidentally make it NOT NULL.
      expect(SQL).not.toMatch(/"source_symbol_id"\s+uuid\s+NOT NULL/i);
    });

    it("cascades on repo, source, and target deletion", () => {
      expect(SQL).toMatch(
        /"repo_id"\s+uuid\s+NOT NULL\s+REFERENCES\s+"code_repositories"\("id"\)\s+ON DELETE CASCADE/i
      );
      expect(SQL).toMatch(
        /"source_symbol_id"\s+uuid\s+REFERENCES\s+"code_symbols"\("id"\)\s+ON DELETE CASCADE/i
      );
      expect(SQL).toMatch(
        /"target_symbol_id"\s+uuid\s+NOT NULL\s+REFERENCES\s+"code_symbols"\("id"\)\s+ON DELETE CASCADE/i
      );
    });

    it("creates the target / source / repo indexes per the handoff", () => {
      expect(SQL).toMatch(
        /CREATE INDEX IF NOT EXISTS\s+"idx_code_references_target"\s+ON\s+"code_references"\s+\(\s*"target_symbol_id"\s*\)/i
      );
      expect(SQL).toMatch(
        /CREATE INDEX IF NOT EXISTS\s+"idx_code_references_source"\s+ON\s+"code_references"\s+\(\s*"source_symbol_id"\s*\)/i
      );
      expect(SQL).toMatch(
        /CREATE INDEX IF NOT EXISTS\s+"idx_code_references_repo"\s+ON\s+"code_references"\s+\(\s*"repo_id"\s*\)/i
      );
    });
  });

  describe("code_type_facts table", () => {
    it("creates the table with IF NOT EXISTS", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS\s+"code_type_facts"/i);
    });

    it("declares every required column", () => {
      const required = [
        ["id", /uuid\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)\s+NOT NULL/i],
        ["symbol_id", /uuid\s+NOT NULL\s+REFERENCES\s+"code_symbols"/i],
        ["param_types", /jsonb/i],
        ["return_type", /text/i],
        ["generic_params", /jsonb/i],
        ["throws", /jsonb/i],
        ["side_effects", /jsonb/i],
      ] as const;
      for (const [col, typePattern] of required) {
        const line = new RegExp(`"${col}"\\s+${typePattern.source}`, typePattern.flags);
        expect(SQL).toMatch(line);
      }
    });

    it("cascades on symbol deletion", () => {
      expect(SQL).toMatch(
        /"symbol_id"\s+uuid\s+NOT NULL\s+REFERENCES\s+"code_symbols"\("id"\)\s+ON DELETE CASCADE/i
      );
    });

    it("creates the symbol_id lookup index", () => {
      expect(SQL).toMatch(
        /CREATE INDEX IF NOT EXISTS\s+"idx_code_type_facts_symbol"\s+ON\s+"code_type_facts"\s+\(\s*"symbol_id"\s*\)/i
      );
    });
  });

  describe("code_imports table", () => {
    it("creates the table with IF NOT EXISTS", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS\s+"code_imports"/i);
    });

    it("declares every required column", () => {
      const required = [
        ["id", /uuid\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)\s+NOT NULL/i],
        ["repo_id", /uuid\s+NOT NULL\s+REFERENCES\s+"code_repositories"/i],
        ["source_file", /text\s+NOT NULL/i],
        ["target_module", /text\s+NOT NULL/i],
        ["resolved_file", /text/i],
        ["imported_names", /jsonb/i],
      ] as const;
      for (const [col, typePattern] of required) {
        const line = new RegExp(`"${col}"\\s+${typePattern.source}`, typePattern.flags);
        expect(SQL).toMatch(line);
      }
    });

    it("cascades on repo deletion", () => {
      expect(SQL).toMatch(
        /"repo_id"\s+uuid\s+NOT NULL\s+REFERENCES\s+"code_repositories"\("id"\)\s+ON DELETE CASCADE/i
      );
    });

    it("creates the (repo_id, source_file) index for forward lookup", () => {
      expect(SQL).toMatch(
        /CREATE INDEX IF NOT EXISTS\s+"idx_code_imports_source"\s+ON\s+"code_imports"\s+\(\s*"repo_id"\s*,\s*"source_file"\s*\)/i
      );
    });

    it("creates the (repo_id, resolved_file) index for transitive invalidation", () => {
      expect(SQL).toMatch(
        /CREATE INDEX IF NOT EXISTS\s+"idx_code_imports_target"\s+ON\s+"code_imports"\s+\(\s*"repo_id"\s*,\s*"resolved_file"\s*\)/i
      );
    });
  });

  describe("idempotency + safety", () => {
    it("guards every CREATE TABLE with IF NOT EXISTS", () => {
      const createTableLines = SQL_NO_COMMENTS.match(/CREATE TABLE[^\n]+/g) ?? [];
      expect(createTableLines.length).toBe(4);
      for (const line of createTableLines) {
        expect(line).toMatch(/IF NOT EXISTS/);
      }
    });

    it("guards every CREATE INDEX with IF NOT EXISTS", () => {
      const createIndexLines = SQL_NO_COMMENTS.match(/CREATE INDEX[^\n]+/g) ?? [];
      expect(createIndexLines.length).toBeGreaterThanOrEqual(9);
      for (const line of createIndexLines) {
        expect(line).toMatch(/IF NOT EXISTS/);
      }
    });

    it("does not drop, alter, or rename existing columns or tables", () => {
      expect(SQL_NO_COMMENTS).not.toMatch(/DROP TABLE/i);
      expect(SQL_NO_COMMENTS).not.toMatch(/DROP COLUMN/i);
      expect(SQL_NO_COMMENTS).not.toMatch(/RENAME COLUMN/i);
      expect(SQL_NO_COMMENTS).not.toMatch(/RENAME TABLE/i);
      expect(SQL_NO_COMMENTS).not.toMatch(/ALTER COLUMN/i);
    });

    it("does not modify v1 tables (code_chunks, code_dependencies, code_repositories)", () => {
      // Phase 1.1 must coexist byte-identical with v1. References to v1 tables
      // should appear ONLY in FK clauses, never in ALTER/DROP/UPDATE.
      expect(SQL_NO_COMMENTS).not.toMatch(/ALTER TABLE\s+"?code_chunks"?/i);
      expect(SQL_NO_COMMENTS).not.toMatch(/ALTER TABLE\s+"?code_dependencies"?/i);
      expect(SQL_NO_COMMENTS).not.toMatch(/ALTER TABLE\s+"?code_repositories"?/i);
    });
  });
});
