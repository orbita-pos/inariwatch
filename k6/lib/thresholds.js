// ── Shared threshold definitions ────────────────────────────────────────────

export const BASE_THRESHOLDS = {
  http_req_duration: ["p(95)<2000", "p(99)<5000"],
  http_req_failed: ["rate<0.05"],
  checks: ["rate>0.95"],
};

export const STRICT_THRESHOLDS = {
  http_req_duration: ["p(95)<1000", "p(99)<3000"],
  http_req_failed: ["rate<0.01"],
  checks: ["rate>0.99"],
};

export const WEBHOOK_THRESHOLDS = {
  ...BASE_THRESHOLDS,
  "http_req_duration{type:webhook}": ["p(95)<1500"],
  "rate_limit_hit": ["rate>0"],  // we EXPECT some 429s
};

export const MCP_THRESHOLDS = {
  ...BASE_THRESHOLDS,
  "http_req_duration{tier:cheap}": ["p(95)<1000"],
  "http_req_duration{tier:moderate}": ["p(95)<3000"],
  "http_req_duration{tier:expensive}": ["p(95)<5000"],
};

export const SSE_THRESHOLDS = {
  "sse_connection_time": ["p(95)<2000"],
  "sse_events_received": ["count>0"],
  checks: ["rate>0.90"],
};

export const DB_THRESHOLDS = {
  ...BASE_THRESHOLDS,
  http_req_duration: ["p(95)<3000", "p(99)<8000"],
  "http_req_failed": ["rate<0.05"],
};

export const CHAOS_THRESHOLDS = {
  ...BASE_THRESHOLDS,
  "chaos_phases_passed": ["count>=1"],
  "chaos_latency": ["p(95)<10000"],
};

export const TENANT_THRESHOLDS = {
  ...BASE_THRESHOLDS,
  "tenant_isolation_delta_ms": ["p(95)<500"], // victim workspace should not degrade >500ms
};

export const SSE_CHAOS_THRESHOLDS = {
  "sse_connection_time": ["p(95)<3000"],
  "sse_leaked_connections": ["count<1"],
  checks: ["rate>0.85"],
};
