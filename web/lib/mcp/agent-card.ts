/**
 * Agent Card — metadata for agent-to-agent delegation (MCP A2A, Q3 2026).
 *
 * When an external agent (AWS DevOps, GitHub Copilot, etc.) detects an error
 * and wants to delegate diagnosis + fix to InariWatch, this card describes
 * what InariWatch can do, what it needs, and what it returns.
 *
 * NOT YET CONNECTED — the A2A spec is not final. This is the contract design
 * so we're ready when it launches. Only adapt the format.
 */

export const INARIWATCH_AGENT_CARD = {
  // ── Identity ──────────────────────────────────────────────────────────────
  name: "inariwatch",
  displayName: "InariWatch Agent",
  version: "1.0.0",
  vendor: "InariWatch",
  homepage: "https://inariwatch.com",
  endpoint: "https://mcp.inariwatch.com",

  // ── Capabilities ──────────────────────────────────────────────────────────
  capabilities: {
    diagnose: {
      description: "AI-powered root cause analysis using stack traces, Sentry, Vercel, GitHub CI, and Substrate I/O recordings",
      input: ["error_message", "stack_trace", "severity"],
      output: ["root_cause", "impact_assessment", "suggested_fix", "confidence_score"],
      sla: { p95_latency_ms: 5000 },
    },
    reproduce: {
      description: "Replay the exact sequence of I/O operations before a crash using Substrate recordings",
      input: ["alert_id"],
      output: ["io_timeline", "crash_point", "preceding_events"],
      requires: ["substrate_recording"],
      sla: { p95_latency_ms: 2000 },
    },
    fix: {
      description: "Full AI remediation: diagnose → read code → generate fix → self-review → push → CI → PR → optional auto-merge",
      input: ["alert_id", "repo_access"],
      output: ["pr_url", "confidence_score", "files_changed", "ci_status"],
      sla: { p95_latency_ms: 300000 }, // up to 5 minutes
    },
    verify: {
      description: "Cryptographic verification of fix: EAP chain validates recording integrity, post-merge monitoring confirms fix stability",
      input: ["alert_id"],
      output: ["verification_status", "checks_passed", "eap_receipt"],
      sla: { p95_latency_ms: 3000 },
    },
    simulate: {
      description: "Analyze whether a proposed fix would resolve a bug based on Substrate I/O recording",
      input: ["alert_id", "fix_description"],
      output: ["success_probability", "risks", "side_effects"],
      requires: ["substrate_recording", "ai_key"],
      sla: { p95_latency_ms: 10000 },
    },
  },

  // ── Delegation contract ────────────────────────────────────────────────────
  delegation: {
    accept: {
      description: "InariWatch accepts delegation when an external agent detects a production error",
      input_schema: {
        type: "object",
        properties: {
          error_message: { type: "string", description: "The error message or title" },
          stack_trace: { type: "string", description: "Full stack trace" },
          severity: { type: "string", enum: ["critical", "warning", "info"] },
          repo: { type: "string", description: "GitHub repo (owner/repo)" },
          environment: { type: "string", description: "production, staging, etc." },
          context: { type: "object", description: "Additional context (request, user, etc.)" },
        },
        required: ["error_message"],
      },
    },
    respond: {
      description: "InariWatch responds with diagnosis, fix, and verification",
      output_schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["diagnosed", "fix_proposed", "fix_merged", "fix_verified", "failed"] },
          diagnosis: { type: "string", description: "Root cause analysis" },
          fix: {
            type: "object",
            properties: {
              pr_url: { type: "string" },
              confidence_score: { type: "number" },
              files_changed: { type: "array", items: { type: "string" } },
            },
          },
          verification: {
            type: "object",
            properties: {
              ci_passed: { type: "boolean" },
              post_merge_monitoring: { type: "string", enum: ["watching", "passed", "reverted"] },
              error_recurred: { type: "boolean" },
            },
          },
        },
      },
    },
  },

  // ── Auth ────────────────────────────────────────────────────────────────────
  auth: {
    type: "oauth2.1",
    scopes: ["read", "write", "execute"],
    token_endpoint: "https://mcp.inariwatch.com/api/mcp/oauth/token",
  },

  // ── SLA ─────────────────────────────────────────────────────────────────────
  sla: {
    availability: "99.9%",
    max_concurrent_delegations: 100,
    supported_languages: ["typescript", "javascript", "python", "go", "rust"],
    supported_frameworks: ["next.js", "express", "fastify", "hono", "node"],
  },
};
