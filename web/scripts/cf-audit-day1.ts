import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Cloudflare "Day 1" setup for the Vercel-level audit.
 * See VERCEL_LEVEL_AUDIT_REPORT.md §A3 + §B3.
 *
 * Creates (idempotently):
 *   - 4 Cache Rules in the http_request_cache_settings ruleset:
 *       app-auth-pages    → cache /login + /register + /forgot + /reset
 *       static-chunks     → cache /_next/static/* 30 d
 *       image-optimizer   → cache /_next/image* 30 d
 *       bypass-dashboard  → bypass cache for /api/* + authenticated paths
 *   - 1 Rate Limit rule in the http_ratelimit ruleset:
 *       auth-endpoints    → 10 req/min/IP on /api/auth/signin + callback
 *
 * Re-runnable: each rule is keyed by its `description` field. If a rule
 * with the same description already exists, we PUT the new definition in
 * place. Otherwise we append.
 *
 * Required CF API token scopes (Zone ID = inariwatch.com):
 *   - Zone: Cache Rules: Edit
 *   - Zone: Dynamic URL Redirects: Read   (needed for Rulesets API)
 *   - Zone: Rate Limit Rules: Edit         (Pro plan required for WAF rate limit;
 *                                           on Free plan, skip the last step)
 *   - Zone: Zone: Read
 *
 * Usage:
 *   npx tsx scripts/cf-audit-day1.ts            # apply all rules
 *   npx tsx scripts/cf-audit-day1.ts dry        # preview only
 *   npx tsx scripts/cf-audit-day1.ts cache      # apply only cache rules
 *   npx tsx scripts/cf-audit-day1.ts ratelimit  # apply only rate limit rule
 *
 * Env (.env.local):
 *   CLOUDFLARE_API_TOKEN   — must have the scopes above
 *   CLOUDFLARE_ZONE_ID     — optional; looked up from zone name if missing
 *   CLOUDFLARE_ZONE_NAME   — defaults to inariwatch.com
 */

const ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME ?? "inariwatch.com";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN missing from .env.local");
  process.exit(1);
}

const API = "https://api.cloudflare.com/client/v4";
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

type CfResp<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ message: string }>;
};

async function api<T = unknown>(path: string, init?: RequestInit): Promise<CfResp<T>> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  const body = (await res.json()) as CfResp<T>;
  if (!body.success) {
    const msg = body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? `HTTP ${res.status}`;
    throw new Error(`cf api ${init?.method ?? "GET"} ${path} failed: ${msg}`);
  }
  return body;
}

async function getZoneId(): Promise<string> {
  if (process.env.CLOUDFLARE_ZONE_ID) return process.env.CLOUDFLARE_ZONE_ID;
  const body = await api<Array<{ id: string; name: string }>>(`/zones?name=${ZONE_NAME}`);
  const zone = body.result.find((z) => z.name === ZONE_NAME);
  if (!zone) throw new Error(`zone ${ZONE_NAME} not found in this account`);
  return zone.id;
}

// ── Rule definitions ──────────────────────────────────────────────────────
//
// Cache Rules (http_request_cache_settings phase).
// Each rule has a unique `description` we use as a stable key for upserts.

type CfRule = {
  description: string;
  expression: string;
  action: "set_cache_settings" | "block" | "skip";
  action_parameters?: Record<string, unknown>;
  ratelimit?: Record<string, unknown>;
  enabled: boolean;
};

const CACHE_RULES: CfRule[] = [
  {
    description: "audit-day1: cache app.* anonymous auth pages",
    expression:
      '(http.host eq "app.inariwatch.com") and ' +
      '(http.request.uri.path in {"/login" "/register" "/forgot-password" "/reset-password"}) and ' +
      '(not http.cookie contains "next-auth.session-token") and ' +
      '(not http.cookie contains "__Secure-next-auth.session-token")',
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: "override_origin",
        default: 86_400,
      },
      browser_ttl: {
        mode: "override_origin",
        default: 0,
      },
    },
    enabled: true,
  },
  {
    description: "audit-day1: cache /_next/static/* on all hosts",
    expression: '(starts_with(http.request.uri.path, "/_next/static/"))',
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: "override_origin",
        default: 2_592_000, // 30 days
      },
      browser_ttl: {
        mode: "respect_origin",
      },
    },
    enabled: true,
  },
  {
    description: "audit-day1: cache /_next/image* on all hosts",
    expression: '(starts_with(http.request.uri.path, "/_next/image"))',
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: "override_origin",
        default: 2_592_000, // 30 days
      },
      browser_ttl: {
        mode: "respect_origin",
      },
    },
    enabled: true,
  },
  {
    description: "audit-day1: bypass cache for /api/* + authenticated app paths",
    expression:
      '(http.host eq "app.inariwatch.com") and (' +
      'starts_with(http.request.uri.path, "/api/") or ' +
      'starts_with(http.request.uri.path, "/dashboard") or ' +
      'starts_with(http.request.uri.path, "/alerts") or ' +
      'starts_with(http.request.uri.path, "/projects") or ' +
      'starts_with(http.request.uri.path, "/settings") or ' +
      'starts_with(http.request.uri.path, "/integrations") or ' +
      'starts_with(http.request.uri.path, "/chat") or ' +
      'starts_with(http.request.uri.path, "/admin") or ' +
      'starts_with(http.request.uri.path, "/recordings") or ' +
      'starts_with(http.request.uri.path, "/sessions") or ' +
      'starts_with(http.request.uri.path, "/on-call") or ' +
      'starts_with(http.request.uri.path, "/analytics") or ' +
      'starts_with(http.request.uri.path, "/workspace")' +
      ')',
    action: "set_cache_settings",
    action_parameters: {
      cache: false,
    },
    enabled: true,
  },
];

// Rate Limiting Rule (http_ratelimit phase).
const RATE_LIMIT_RULES: CfRule[] = [
  {
    description: "audit-day1: rate limit NextAuth credentials endpoints",
    expression:
      '(http.host eq "app.inariwatch.com") and ' +
      '(http.request.uri.path in {' +
      '"/api/auth/signin" ' +
      '"/api/auth/callback/credentials" ' +
      '"/api/auth/signin/credentials"' +
      '})',
    action: "block",
    ratelimit: {
      characteristics: ["ip.src", "cf.colo.id"],
      period: 60,
      requests_per_period: 10,
      mitigation_timeout: 600,
    },
    enabled: true,
  },
];

// ── Upsert logic ──────────────────────────────────────────────────────────

interface EntrypointRule {
  id?: string;
  description?: string;
  expression: string;
  action: string;
  action_parameters?: Record<string, unknown>;
  ratelimit?: Record<string, unknown>;
  enabled: boolean;
}

interface RulesetEntrypoint {
  id: string;
  rules?: EntrypointRule[];
}

async function upsertRules(zoneId: string, phase: string, desired: CfRule[], label: string, dry: boolean) {
  console.log(`\n[${label}] Loading current ${phase} entrypoint…`);

  const current = await api<RulesetEntrypoint>(
    `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`,
  ).catch(async (err) => {
    // Entrypoint may not exist yet on a fresh zone — create empty.
    if (String(err).includes("404") || String(err).toLowerCase().includes("not found")) {
      console.log(`[${label}] entrypoint not found; will create on PUT`);
      return { success: true, result: { id: "", rules: [] } } as CfResp<RulesetEntrypoint>;
    }
    throw err;
  });

  const currentRules = current.result.rules ?? [];
  console.log(`[${label}] current rules in entrypoint: ${currentRules.length}`);
  for (const r of currentRules) {
    console.log(`  • ${r.description ?? r.expression.slice(0, 60)}`);
  }

  // Build the new rules array: keep any rule whose description doesn't
  // match one of ours (so we don't clobber unrelated rules), then append
  // our desired rules in the order listed above.
  const ourDescriptions = new Set(desired.map((r) => r.description));
  const preserved = currentRules.filter((r) => !ourDescriptions.has(r.description ?? ""));
  const next: EntrypointRule[] = [...preserved];
  for (const rule of desired) {
    next.push({
      description: rule.description,
      expression: rule.expression,
      action: rule.action,
      ...(rule.action_parameters ? { action_parameters: rule.action_parameters } : {}),
      ...(rule.ratelimit ? { ratelimit: rule.ratelimit } : {}),
      enabled: rule.enabled,
    });
  }

  console.log(`[${label}] new rule count (preserved + ours): ${next.length}`);
  for (const rule of desired) {
    console.log(`  + ${rule.description}`);
  }

  if (dry) {
    console.log(`[${label}] DRY RUN — not submitting.`);
    return;
  }

  console.log(`[${label}] PUTting updated entrypoint…`);
  await api(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, {
    method: "PUT",
    body: JSON.stringify({ rules: next }),
  });
  console.log(`[${label}] done.`);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const mode = (process.argv[2] ?? "all").toLowerCase();
  const dry = mode === "dry";
  const runCache = dry || mode === "all" || mode === "cache";
  const runRateLimit = dry || mode === "all" || mode === "ratelimit";

  const zoneId = await getZoneId();
  console.log(`zone: ${ZONE_NAME}  (id=${zoneId})  mode=${mode}`);

  if (runCache) {
    await upsertRules(zoneId, "http_request_cache_settings", CACHE_RULES, "cache", dry);
  }
  if (runRateLimit) {
    try {
      await upsertRules(zoneId, "http_ratelimit", RATE_LIMIT_RULES, "ratelimit", dry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("403") || msg.toLowerCase().includes("not authorized") || msg.toLowerCase().includes("permission")) {
        console.error("\n[ratelimit] SKIPPED — your API token lacks 'Zone: Rate Limit Rules: Edit' scope,");
        console.error("           OR your Cloudflare plan does not include WAF Rate Limiting.");
        console.error("           On the Free plan you can configure a simple rate limit via the dashboard:");
        console.error("           Security → WAF → Rate limiting rules → Create rule");
      } else {
        throw err;
      }
    }
  }

  console.log("\nAll done. Verify in CF dashboard → Caching → Cache Rules + Security → WAF → Rate limiting rules.");
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
