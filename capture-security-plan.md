# Plan: @inariwatch/capture Runtime Security — Source-to-Sink Detection

## Vision

Transform @inariwatch/capture from a passive error tracker into an active security monitor that detects vulnerabilities at runtime AND auto-fixes them. No other product does both.

**Pitch:** "Sentry catches your errors. InariWatch catches your errors, detects the attacks, and fixes the vulnerable code — automatically."

## How it works

### Source-to-sink tracking (not regex WAF)

Instead of pattern-matching HTTP requests (like a WAF), we hook the actual dangerous operations (database queries, shell commands, file reads) and detect when unsanitized user input reaches them.

**Example flow:**
1. User sends `'; DROP TABLE users--` as a search query
2. Capture tracks this input as "tainted" (came from user request)
3. The app passes it to `pg.query("SELECT * FROM users WHERE name = '" + input + "'")`
4. Capture's hook on `pg.query` detects tainted input inside the SQL string
5. Capture reports: `{ type: "security", sink: "pg.query", source: "req.query.q", file: "api/search/route.ts", line: 45, vulnerability: "sql_injection" }`
6. InariWatch receives the alert, AI reads the code, generates parameterized query fix, creates PR

### Why source-to-sink > regex

| | Regex WAF | Source-to-Sink |
|---|---|---|
| `?q=SELECT` in a SQL tutorial app | FALSE POSITIVE | Correct: no sink reached |
| `?q='; DROP TABLE--` to parameterized query | FALSE POSITIVE | Correct: sink is safe (parameterized) |
| `?q=test` to string-concatenated query | NOT DETECTED | Detected: tainted input in unsafe sink |
| Encoded bypass `%27%20OR%201%3D1` | BYPASSED | Detected: decoded input reaches sink |

Source-to-sink has near-zero false positives because it detects the **vulnerability**, not the **attack attempt**.

## Architecture

### New export: `@inariwatch/capture/shield`

```typescript
// Option A: Auto-instrumentation (recommended for Next.js)
// instrumentation.ts
import "@inariwatch/capture/auto"
import "@inariwatch/capture/shield" // ← NEW: hooks sinks automatically

// Option B: Manual middleware (for Express/Fastify)
import { shield } from "@inariwatch/capture/shield"
app.use(shield()) // ← marks request inputs as tainted
```

### What we hook (sinks)

**Phase 1 — High value, most common:**

| Sink | Module | Vulnerability | Hook method |
|---|---|---|---|
| SQL queries | `pg`, `pg-pool` | SQL Injection | Wrap `.query()` |
| SQL queries | `mysql2` | SQL Injection | Wrap `.execute()`, `.query()` |
| SQL queries | `better-sqlite3` | SQL Injection | Wrap `.prepare()`, `.exec()` |
| Shell commands | `child_process` | Command Injection | Wrap `exec()`, `execSync()`, `spawn()` |
| File operations | `fs` | Path Traversal | Wrap `readFile()`, `readFileSync()`, `writeFile()` |

**Phase 2 — Extended coverage:**

| Sink | Module | Vulnerability | Hook method |
|---|---|---|---|
| NoSQL queries | `mongodb` | NoSQL Injection | Wrap `.find()`, `.findOne()`, `.aggregate()` |
| HTTP requests | `fetch`, `http` | SSRF | Wrap `fetch()`, `http.request()` |
| Template rendering | `ejs`, `pug` | Template Injection | Wrap `.render()` |
| Deserialization | `JSON.parse` on tainted input | Prototype Pollution | Check for `__proto__` keys |

### What we mark as tainted (sources)

| Source | Framework | How |
|---|---|---|
| Query params | Express `req.query` | Hook at middleware level |
| URL params | Express `req.params` | Hook at middleware level |
| Request body | Express `req.body` | Hook at middleware level |
| Headers | Express `req.headers` | Hook at middleware level |
| Cookies | Express `req.cookies` | Hook at middleware level |
| Next.js request | `request.nextUrl.searchParams` | Hook via instrumentation |

### Taint tracking approach

We use **string-level taint marking** — not V8 native taint tracking (too heavy, needs C++ addon like Datadog). Instead:

```typescript
// WeakMap to track tainted strings without modifying them
const taintedInputs = new WeakSet<object>()
const taintedStrings = new Map<string, TaintSource>()

// When user input enters the system:
function markTainted(input: string, source: TaintSource): string {
  taintedStrings.set(input, source)
  return input // no modification
}

// When a sink is called:
function checkSink(sinkName: string, args: unknown[]): ThreatDetection | null {
  for (const arg of args) {
    if (typeof arg === "string") {
      // Check if any tainted input appears inside this string
      for (const [tainted, source] of taintedStrings) {
        if (arg.includes(tainted) && tainted.length >= 3) {
          return {
            vulnerability: classifyVulnerability(sinkName),
            sink: sinkName,
            source: source,
            taintedInput: tainted,
            sinkArgument: arg.slice(0, 500),
          }
        }
      }
    }
  }
  return null
}
```

**Limitation:** String-level tracking doesn't follow through `substring()`, `replace()`, `split()`, etc. This catches the majority of real-world cases (most apps pass user input directly or via simple concatenation) but misses complex transformations. V8 taint tracking (Datadog) catches everything but requires a native C++ addon.

**Why this is acceptable for v1:** Aikido Zen uses the same approach (not V8 taint tracking) and successfully detects most real-world vulnerabilities. The improvement path to V8 taint tracking is available later if needed.

### Event schema

New event type: `"security"`

```typescript
interface SecurityEvent extends ErrorEvent {
  eventType: "security"
  severity: "critical" // security events are always critical
  securityContext: {
    vulnerability: "sql_injection" | "command_injection" | "path_traversal" | "ssrf" | "nosql_injection" | "prototype_pollution"
    sink: string           // "pg.query", "child_process.exec", "fs.readFile"
    sinkModule: string     // "pg", "child_process", "fs"  
    sinkFile?: string      // file where sink was called (from stack trace)
    sinkLine?: number      // line number
    source: string         // "req.query.q", "req.body.username", "req.params.id"
    taintedInput: string   // the actual user input (truncated, redacted)
    sinkArgument: string   // what was passed to the sink (truncated)
    blocked: boolean       // whether the request was blocked
  }
}
```

### Backend changes

1. **Receiver** (`web/app/api/webhooks/capture/[integrationId]/route.ts`):
   - Read `eventType` field (currently ignored)
   - Store in new `alertType` column or in `correlationData.eventType`

2. **DB migration**:
   ```sql
   ALTER TABLE alerts ADD COLUMN alert_type TEXT DEFAULT 'error' NOT NULL;
   CREATE INDEX idx_alerts_type ON alerts(alert_type);
   ```

3. **Auto-analyze** (`web/lib/ai/auto-analyze.ts`):
   - New prompt for security alerts:
   ```
   Analyze this SECURITY alert:
   Vulnerability: SQL Injection
   Sink: pg.query() at api/search/route.ts:45
   Source: req.query.q
   Tainted input: "'; DROP TABLE users--"
   
   1. Is this a real vulnerability or false positive?
   2. What's the impact if exploited?
   3. How should the code be fixed?
   ```

4. **Remediation** — security alerts trigger remediation with precise context:
   - AI knows exactly which file, line, function is vulnerable
   - AI knows the sink type (SQL → use parameterized queries)
   - Higher confidence fixes because the context is precise

5. **Dashboard** — new tab "Security" or filter `alertType: "security"`:
   - Shows vulnerability type, sink, source
   - Groups by vulnerability class
   - Shows "Attack attempts" count (how many times the vulnerable endpoint was hit)

### Mode: report vs block

```typescript
import { shield } from "@inariwatch/capture/shield"

// Report-only (default) — detects and reports, doesn't block
app.use(shield())

// Block mode — returns 403 on detected attacks
app.use(shield({ mode: "block" }))

// Block with custom response
app.use(shield({ 
  mode: "block",
  onBlock: (req, res, threat) => {
    res.status(403).json({ error: "Request blocked by security policy" })
  }
}))
```

Default is report-only because:
- Zero risk of breaking the user's app
- Still provides full value (detection + auto-fix)
- Block mode is opt-in for users who want WAF-like behavior

## Implementation plan

### Phase 1: Core infrastructure (1-2 days)

1. Create `capture/src/shield/` directory:
   - `taint.ts` — taint tracking (WeakMap-based)
   - `sinks.ts` — sink hooks (pg, mysql2, child_process, fs)
   - `sources.ts` — source hooks (Express req, Next.js request)
   - `detect.ts` — vulnerability classification
   - `index.ts` — main export, auto-hooks on import

2. Add `"./shield"` to capture package.json exports

3. Backend: add `alertType` column + update receiver

### Phase 2: Sink hooks (2-3 days)

Hook the 5 Phase 1 sinks:
- `pg` — wrap Client.query, Pool.query
- `mysql2` — wrap Connection.execute, Connection.query
- `better-sqlite3` — wrap Database.prepare, Database.exec
- `child_process` — wrap exec, execSync, spawn, spawnSync
- `fs` — wrap readFile, readFileSync, writeFile, writeFileSync

Each hook:
1. Intercepts the call
2. Checks if any argument contains tainted input
3. If yes: reports security event via `captureException` with `securityContext`
4. If `mode: "block"`: throws or rejects before the sink executes

### Phase 3: Source hooks (1 day)

Express/Fastify/Hono middleware:
- Marks `req.query`, `req.params`, `req.body`, `req.headers`, `req.cookies` as tainted
- Each tainted value tracked with source info ("req.query.q", "req.body.password")

Next.js:
- Hook via instrumentation.ts or middleware.ts
- Mark `request.nextUrl.searchParams`, `request.headers` as tainted

### Phase 4: Dashboard + remediation (1-2 days)

- New alert type display
- Security-specific auto-analyze prompt
- Remediation with precise sink/source context
- Security dashboard (vulnerability summary, attack attempts)

### Phase 5: Testing with tester app (1 day)

Update the tester app chaos panel:
- SQL Injection toggle → capture/shield detects it at the pg.query sink
- Command Injection toggle → capture/shield detects it at child_process.exec
- Path Traversal toggle → capture/shield detects it at fs.readFile
- All detected WITHOUT crash, reported as security alerts, auto-fixed

## Study material

- **Aikido Zen source code** (AGPL): https://github.com/AikidoSec/firewall-node — study their sink hooks for pg, mysql2, mongodb, child_process
- **Datadog dd-trace-js**: https://github.com/DataDog/dd-trace-js — study ASM/IAST integration points
- **Node.js module hooking**: `require('module')._resolveFilename` or `--require` flag for monkey-patching

## What NOT to do

- Don't build a regex WAF — it's the wrong abstraction for a monitoring tool
- Don't try V8 taint tracking (native C++ addon) — too complex for v1, can upgrade later
- Don't block by default — report-only is safer and still triggers remediation
- Don't hook every library — start with pg + child_process + fs, expand based on demand
- Don't compete with Cloudflare WAF on network-level — capture operates at the application level

## Success metric

A user with SQL injection in their code:
1. Installs `@inariwatch/capture` + imports `shield`
2. Gets a security alert in their dashboard showing exactly which line is vulnerable
3. Clicks "Fix with AI"
4. InariWatch generates a parameterized query fix
5. PR merged, vulnerability closed

From install to fix: <5 minutes. No other product does this.
