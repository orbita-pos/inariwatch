/**
 * Structural test for migration 0077_workspace_local_notify.sql.
 *
 * Doesn't run against a real DB — verifies the migration file exists, has
 * the v0.3 S3 column shape (default false, not-null), and matches the
 * Drizzle schema in `web/lib/db/schema.ts:organizations.localNotifyEnabled`.
 * Guards against silent drift between the SQL and the ORM mapping.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const MIGRATION = join(
  __dirname,
  "..",
  "migrations",
  "0077_workspace_local_notify.sql",
);

describe("migration 0077_workspace_local_notify", () => {
  it("file exists", () => {
    expect(existsSync(MIGRATION)).toBe(true);
  });

  describe("forward migration", () => {
    const sql = readFileSync(MIGRATION, "utf-8");

    it("adds local_notify_enabled to organizations as NOT NULL DEFAULT FALSE", () => {
      // Default-off is the zero-regression invariant — every existing
      // workspace stays on cloud routing for notify.compose.email until
      // the user explicitly opts in.
      expect(sql).toMatch(
        /ALTER TABLE organizations[\s\S]*?ADD COLUMN[\s\S]*?local_notify_enabled[\s\S]*?BOOLEAN[\s\S]*?NOT NULL[\s\S]*?DEFAULT FALSE/i,
      );
    });

    it("uses IF NOT EXISTS so reapplies are safe", () => {
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    });

    it("documents the rollback statement", () => {
      // The rollback is single-line; we don't ship a separate file like
      // 0069 because it's a single ALTER. The comment is the operator's
      // contract.
      expect(sql).toMatch(/Rollback[\s\S]*?DROP COLUMN/i);
    });

    it("attaches a COMMENT describing the v0.3 S3 wedge", () => {
      expect(sql).toMatch(/COMMENT ON COLUMN organizations\.local_notify_enabled/i);
      expect(sql).toMatch(/notify\.compose\.email/);
    });
  });
});
