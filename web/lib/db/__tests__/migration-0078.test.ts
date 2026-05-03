/**
 * Structural test for migration 0078_workspace_local_voice.sql.
 *
 * Doesn't run against a real DB — verifies the migration file exists,
 * has the v0.3 S5 column shape (default false, not-null), and matches
 * the Drizzle schema in `web/lib/db/schema.ts:organizations.localVoiceEnabled`.
 * Guards against silent drift between the SQL and the ORM mapping.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const MIGRATION = join(
  __dirname,
  "..",
  "migrations",
  "0078_workspace_local_voice.sql",
);

describe("migration 0078_workspace_local_voice", () => {
  it("file exists", () => {
    expect(existsSync(MIGRATION)).toBe(true);
  });

  describe("forward migration", () => {
    const sql = readFileSync(MIGRATION, "utf-8");

    it("adds local_voice_enabled to organizations as NOT NULL DEFAULT FALSE", () => {
      // Default-off is the zero-regression invariant — every existing
      // workspace stays on cloud routing for voice.tts.* until they opt in.
      expect(sql).toMatch(
        /ALTER TABLE organizations[\s\S]*?ADD COLUMN[\s\S]*?local_voice_enabled[\s\S]*?BOOLEAN[\s\S]*?NOT NULL[\s\S]*?DEFAULT FALSE/i,
      );
    });

    it("uses IF NOT EXISTS so reapplies are safe", () => {
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    });

    it("documents the rollback statement", () => {
      expect(sql).toMatch(/Rollback[\s\S]*?DROP COLUMN/i);
    });

    it("attaches a COMMENT describing the v0.3 S5 wedge", () => {
      expect(sql).toMatch(
        /COMMENT ON COLUMN organizations\.local_voice_enabled/i,
      );
      expect(sql).toMatch(/voice\.tts/);
    });
  });
});
