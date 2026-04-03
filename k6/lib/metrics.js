import { Counter, Rate, Trend } from "k6/metrics";

// ── Webhook metrics ─────────────────────────────────────────────────────────
export const webhooksAccepted = new Counter("webhooks_accepted");
export const webhooksRejected = new Counter("webhooks_rejected");
export const webhooksRateLimited = new Counter("webhooks_rate_limited");
export const webhookLatency = new Trend("webhook_latency", true);

// ── MCP metrics ─────────────────────────────────────────────────────────────
export const mcpCallsTotal = new Counter("mcp_calls_total");
export const mcpRateLimited = new Counter("mcp_rate_limited");
export const mcpLatency = new Trend("mcp_latency", true);

// ── SSE metrics ─────────────────────────────────────────────────────────────
export const sseConnectionTime = new Trend("sse_connection_time", true);
export const sseEventsReceived = new Counter("sse_events_received");
export const sseReconnects = new Counter("sse_reconnects");

// ── Dedup metrics ───────────────────────────────────────────────────────────
export const dedupAlertsCreated = new Counter("dedup_alerts_created");
export const dedupDuplicatesBlocked = new Counter("dedup_duplicates_blocked");
export const dedupAccuracy = new Rate("dedup_accuracy");

// ── Auth metrics ────────────────────────────────────────────────────────────
export const authAttemptsTotal = new Counter("auth_attempts_total");
export const authRateLimited = new Counter("auth_rate_limited");
export const authSuccessful = new Counter("auth_successful");

// ── DB metrics ──────────────────────────────────────────────────────────────
export const dbQueryLatency = new Trend("db_query_latency", true);
export const dbErrors = new Counter("db_errors");
export const dbConcurrentQueries = new Counter("db_concurrent_queries");

// ── Push metrics ────────────────────────────────────────────────────────────
export const pushSent = new Counter("push_sent");
export const pushFailed = new Counter("push_failed");
export const pushLatency = new Trend("push_latency", true);

// ── Auto-heal metrics ───────────────────────────────────────────────────────
export const healTriggered = new Counter("heal_triggered");
export const healCooldownBlocked = new Counter("heal_cooldown_blocked");
export const timeToDetect = new Trend("time_to_detect", true);
export const timeToHeal = new Trend("time_to_heal", true);

// ── Rate limit metrics (shared) ─────────────────────────────────────────────
export const rateLimitHit = new Rate("rate_limit_hit");
