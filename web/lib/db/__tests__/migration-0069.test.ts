/**
 * Structural tests for migration 0069_telemetry_foundation.sql.
 *
 * These don't run the migration against a real database — they assert that
 * the migration file exists, pairs with a rollback file, and contains the
 * columns/tables the plan in REMEDIATION_SYSTEM_ARCHITECTURE.md §4 Fase 1
 * requires. This guards against silent drift between the plan and the SQL.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const FORWARD = join(MIGRATIONS_DIR, "0069_telemetry_foundation.sql");
const ROLLBACK = join(MIGRATIONS_DIR, "0069_telemetry_foundation.rollback.sql");

describe("migration 0069_telemetry_foundation", () => {
  it("has a forward and a rollback file", () => {
    expect(existsSync(FORWARD)).toBe(true);
    expect(existsSync(ROLLBACK)).toBe(true);
  });

  describe("forward migration", () => {
    const sql = readFileSync(FORWARD, "utf-8");

    it("adds every required column to ai_usage_logs", () => {
      const required = [
        "turn_number",
        "ttft_ms",
        "phase",
        "model_tier",
        "tool_name",
        "tool_exec_ms",
        "reasoning_tokens",
      ];
      for (const col of required) {
        expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`));
      }
    });

    it("adds every required column to remediation_sessions", () => {
      const required = [
        "tier_used",
        "hypothesis_count",
        "pattern_match_score",
        "sandbox_mode",
        "sdk_peer_enabled",
      ];
      for (const col of required) {
        expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`));
      }
    });

    it("creates the sandbox_audit_log table", () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS sandbox_audit_log/);
      expect(sql).toMatch(/code_hash TEXT NOT NULL/);
      expect(sql).toMatch(/purpose TEXT NOT NULL/);
      expect(sql).toMatch(/success BOOLEAN NOT NULL/);
    });

    it("creates the pattern_memory table with a 1024-dim pgvector column", () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS pattern_memory/);
      expect(sql).toMatch(/embedding vector\(1024\)/);
    });

    it("creates an HNSW cosine index on pattern_memory.embedding", () => {
      expect(sql).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
    });

    it("declares a unique (project_id, error_fingerprint) index on pattern_memory", () => {
      expect(sql).toMatch(/UNIQUE INDEX[\s\S]*?pattern_memory\s*\(project_id, error_fingerprint\)/);
    });

    it("uses IF NOT EXISTS guards so the migration is idempotent", () => {
      // Every CREATE TABLE / CREATE INDEX / ALTER .. ADD COLUMN must guard.
      const createTableLines = sql.match(/CREATE TABLE[^\n]+/g) ?? [];
      for (const line of createTableLines) {
        expect(line).toMatch(/IF NOT EXISTS/);
      }

      const addColumnLines = sql.match(/ADD COLUMN[^,\n]+/g) ?? [];
      for (const line of addColumnLines) {
        expect(line).toMatch(/IF NOT EXISTS/);
      }
    });

    it("enables pgvector before using vector(1024)", () => {
      const extIdx = sql.indexOf("CREATE EXTENSION IF NOT EXISTS vector");
      const vecIdx = sql.indexOf("vector(1024)");
      expect(extIdx).toBeGreaterThanOrEqual(0);
      expect(vecIdx).toBeGreaterThan(extIdx);
    });
  });

  describe("rollback", () => {
    const sql = readFileSync(ROLLBACK, "utf-8");

    it("drops both new tables", () => {
      expect(sql).toMatch(/DROP TABLE IF EXISTS pattern_memory/);
      expect(sql).toMatch(/DROP TABLE IF EXISTS sandbox_audit_log/);
    });

    it("drops every column added to ai_usage_logs", () => {
      const cols = [
        "turn_number",
        "ttft_ms",
        "phase",
        "model_tier",
        "tool_name",
        "tool_exec_ms",
        "reasoning_tokens",
      ];
      for (const col of cols) {
        expect(sql).toMatch(new RegExp(`DROP COLUMN IF EXISTS ${col}`));
      }
    });

    it("drops every column added to remediation_sessions", () => {
      const cols = [
        "tier_used",
        "hypothesis_count",
        "pattern_match_score",
        "sandbox_mode",
        "sdk_peer_enabled",
      ];
      for (const col of cols) {
        expect(sql).toMatch(new RegExp(`DROP COLUMN IF EXISTS ${col}`));
      }
    });

    it("leaves the pgvector extension alone (0028 still depends on it)", () => {
      expect(sql).not.toMatch(/DROP EXTENSION .* vector/i);
    });
  });
});
