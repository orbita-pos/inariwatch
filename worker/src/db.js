"use strict";
/**
 * Minimal Neon database connection for the worker.
 * Only accesses remediation_sessions table (progress updates).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.remediationSessions = void 0;
var serverless_1 = require("@neondatabase/serverless");
var neon_http_1 = require("drizzle-orm/neon-http");
var pg_core_1 = require("drizzle-orm/pg-core");
// ── Schema (subset of web/lib/db/schema.ts) ─────────────────────────────────
exports.remediationSessions = (0, pg_core_1.pgTable)("remediation_sessions", {
    id: (0, pg_core_1.uuid)("id").primaryKey().defaultRandom(),
    status: (0, pg_core_1.text)("status").notNull().default("analyzing"),
    steps: (0, pg_core_1.jsonb)("steps").notNull().default([]),
    error: (0, pg_core_1.text)("error"),
    fileChanges: (0, pg_core_1.jsonb)("file_changes"),
    confidenceScore: (0, pg_core_1.integer)("confidence_score"),
    checkpointPhase: (0, pg_core_1.text)("checkpoint_phase"),
    checkpointData: (0, pg_core_1.jsonb)("checkpoint_data"),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true }).defaultNow().notNull(),
});
// ── Connection ──────────────────────────────────────────────────────────────
var DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL)
    throw new Error("DATABASE_URL is required");
var sql = (0, serverless_1.neon)(DATABASE_URL);
exports.db = (0, neon_http_1.drizzle)(sql);
