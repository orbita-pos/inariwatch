/**
 * Minimal Neon database connection for the worker.
 * Only accesses remediation_sessions table (progress updates).
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { pgTable, uuid, text, jsonb, integer, timestamp } from "drizzle-orm/pg-core";

// ── Schema (subset of web/lib/db/schema.ts) ─────────────────────────────────

export const remediationSessions = pgTable("remediation_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull().default("analyzing"),
  steps: jsonb("steps").notNull().default([]),
  error: text("error"),
  fileChanges: jsonb("file_changes"),
  confidenceScore: integer("confidence_score"),
  checkpointPhase: text("checkpoint_phase"),
  checkpointData: jsonb("checkpoint_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Connection ──────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const sql = neon(DATABASE_URL);
export const db = drizzle(sql);
