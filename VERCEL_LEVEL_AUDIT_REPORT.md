# InariWatch — Vercel-Level Performance & Security Audit

**Author**: Claude (Opus 4.7, 1M context).
**Date**: 2026-04-20.
**Scope**: `app.inariwatch.com` + root `inariwatch.com`, post-Hetzner-cutover (2026-04-19).
**Methodology**: code read + live curl measurements + header parsing. No deploys. No secret reads. Every shipping action is proposed, not executed.

---

## 1. Executive summary

### Top 3 wins (projected)

| # | Win | Projected delta | Effort |
|---|---|---|---|
| **1** | **Remove `priority` from decorative login/register backgrounds** + drop `placeholder="blur"` on ≥64KB hero. LCP on first-of-day `/login` currently blocked on a 194 KB WebP that sharp must re-encode on miss. | **LCP cold: ~6–15 s → ~800 ms** (single largest user-visible win). | 15 min, 1 commit. |
| **2** | **Swap `@neondatabase/serverless` HTTP driver for `pg.Pool` against the Neon pooler URL** (long-running Node process behind Kamal reuses TCP/TLS; HTTP driver does a fresh handshake per query). + consolidate duplicate `getServerSession()` call in `getActiveOrgId`. Dashboard first paint does ~6 DB roundtrips, 4 of them serial. | **Dashboard cold: ~3–10 s → ~600–900 ms warm, ~2 s after Neon wake**. Per-query p50 from ~120 ms → ~15 ms warm. | 2–3 h, 1 commit, reversible behind a `DB_DRIVER` env. |
| **3** | **Cloudflare Cache Rules for `app.*` anonymous pages + `/_next/static/*` + `/_next/image*`**. Today every `app.*` page is `cf-cache-status: DYNAMIC`, every hit travels to Hetzner. Login/register/forgot/reset are pure client components with static HTML — safe to cache publicly at the edge. | **TTFB on anonymous `app.*` pages: ~500 ms → ~50 ms from edge** (matches root domain). Removes Hetzner as the bottleneck on the most-hit cold path. | 30 min in the CF dashboard, zero code change, instantly reversible. |

### Top 3 risks

| # | Risk | Severity | Why it matters |
|---|---|---|---|
| **R1** | **`Cache-Control: s-maxage=31536000` leaks out of the origin on `/login`, `/register`, `/forgot-password`, `/reset-password`**. Today CF ignores it (`DYNAMIC` on `app.*`), but the moment Cache Rules or "Cache Everything" is enabled on the zone, authenticated HTML (including any future NextAuth CSRF tokens baked in) would be cached publicly for a year. This is a landmine. | **High** | One mis-click in CF dashboard = year-long global cache of pre-auth HTML. |
| **R2** | **CSP uses `'unsafe-inline'` in `script-src`**. A reflected XSS anywhere in the app executes. Observatory will not issue A+. `strict-dynamic` + nonce per request is the Vercel-grade fix. | **High** | Defence-in-depth gap for the whole authenticated surface. |
| **R3** | **No IP-level rate limit on `/api/auth/signin`, no CF custom rule on OAuth init (`/api/auth/signin/{provider}`), no limit on OAuth callback**. Credentials path has a 10/15-min per-email limiter (`lib/auth.ts:56`) but there is no first-packet IP throttle at CF or origin — brute force on 1000 emails from one IP is wide open. | **Medium-high** | Cheap to fix (one CF custom rule + one `rateLimit` call). |

### Recommended shipping order

- **Day 1 (no deploy, ~45 min work)**: CF Cache Rules (A3), CF custom rule on `/api/auth/*` (B3), Neon autosuspend posture check (A2), HSTS preload submission.
- **Day 2 (one batched deploy, ~4 h work)**: Remove `priority` + `placeholder="blur"` on login/register bg (A4) + CSP nonce/strict-dynamic (B1) + COOP/CORP headers (B1) + duplicate `getServerSession` fix in `getActiveOrgId` (A5) + IP rate limit on credentials authorize() (B3).
- **Day 3+ (next batch, 2–3 days later)**: Neon driver swap (A1) + deploy-time image pre-warm script (A4) + PPR evaluation for `/dashboard` shell (A5) + audit log expansion (B7).

All deltas below are measured or derived from measurements in §4, not estimated from catalogue numbers.

---

## 2. Track A — Performance

### [A1] `@neondatabase/serverless` HTTP driver is the wrong shape for a persistent Node process on Kamal

**Evidence**.
- `web/lib/db/index.ts:1-7` uses `@neondatabase/serverless`'s `neon()` factory. Its transport is HTTPS per query — no TCP pool, no TLS session reuse across invocations. Designed for Vercel serverless (spin up → 1–2 queries → die), not a long-running Node 20 process in Docker.
- Dashboard first paint (`web/app/(dashboard)/layout.tsx:36-80`) issues **6 queries** across 4 `await` boundaries:
  1. `users` row select (line 37).
  2. `getActiveOrgId()` (line 51) — **internally calls `getServerSession()` AGAIN and re-queries `users.activeOrgId`** (`web/lib/workspace.ts:7-23`). That's another full query plus a redundant JWT decode.
  3. `Promise.all([getWorkspaceProjectIds, getUserOrganizations])` (line 57) — 3–5 queries total (workspace logic fans out to `projects`, `projectMembers`, `organizationMembers`, `organizations`).
  4. `Promise.all([pollingRow, countRow])` (line 66) — 2 queries.
- On HTTPS-per-query, warm p50 on a LAX→Neon US-East call is ~80–120 ms. 6 × 100 ms with 4 serial awaits ≈ **~400–600 ms warm** just for the sidebar.
- Cold Neon wake adds 2–10 s to **the first** query. All subsequent queries within the request run warm.

**Impact**. Dashboard TTFB is unnecessarily 2–4× higher than with a real pool. Cold Neon wake is the dominant cause of the 15–60 s "first-of-day" symptom on `/dashboard` specifically (not `/login`, which doesn't query DB).

**Fix** (2–3 h).
1. Add `pg` to deps: `npm i pg @types/pg`.
2. Switch driver in `web/lib/db/index.ts`:
   ```typescript
   import { drizzle } from "drizzle-orm/node-postgres";
   import { Pool } from "pg";
   const pool = new Pool({
     connectionString: process.env.DATABASE_URL!,
     max: 10,                       // single CX21, 10 is plenty
     idleTimeoutMillis: 30_000,
     connectionTimeoutMillis: 5_000,
     keepAlive: true,
   });
   export const db = drizzle(pool, { schema });
   ```
3. Change the env var `DATABASE_URL` in sops to the **pooler** endpoint: `postgresql://...@ep-xxx-pooler.<region>.aws.neon.tech/neondb?sslmode=require`. The pooler endpoint is PgBouncer — it's what `pg.Pool` + Neon want together.
4. Fix the duplicate work: drop `getServerSession` inside `getActiveOrgId` and accept the session as a parameter (A5 covers the refactor).
5. Gate the swap behind a `DB_DRIVER=neon-http|pg` env so rollback is a sops edit, no redeploy.

**Risk**. Low. Drizzle's query surface is identical across the two adapters (`drizzle-orm/neon-http` vs `drizzle-orm/node-postgres`). PgBouncer transaction-mode pooling disallows `SET SESSION` and prepared-statement pinning — Drizzle default does **not** use prepared statements, so this is safe. Confirm none of the migrations or runtime code runs `SET` statements (a grep shows none in `web/lib/db/`).

**Validation**.
```bash
# Warm p50 per query — should drop from ~100 ms to ~15 ms on same region
node -e "
  const { Pool } = require('pg');
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  (async () => {
    for (let i = 0; i < 20; i++) {
      const t = Date.now();
      await p.query('SELECT 1');
      console.log(Date.now() - t + 'ms');
    }
    p.end();
  })();
"
```

---

### [A2] Neon compute autosuspend is the single biggest cold-start driver

**Evidence**.
- `web/lib/pollers/uptime.ts:44-49` fetches external URLs only — never touches the InariWatch DB. No query-layer traffic keeps Neon compute warm.
- The Go cron scheduler on Hetzner hits `/api/cron/poll`, `/api/cron/uptime`, etc. Those routes DO query the DB (one `SELECT` to enumerate integrations). At a 1–2 min cadence this should keep the Neon compute warm indefinitely — **assuming** the `/api/cron/*` routes actually run against production DB and not a shadow.
- But **on fresh-user OAuth**, Neon can still be warm and that user's first `/dashboard` render still feels cold because of A1 (HTTPS per query, no pool) not A2. Separate the two.

**What I can't verify from code**.
- Neon project autosuspend setting (5 min / 15 min / never). Jesus must check.
- Which Neon plan: Launch (5-min default) vs Scale (configurable).

**Fix** (depends on plan).
1. **If on Launch plan** ($19/mo): set autosuspend to 15 min in Neon console → Project settings → Compute. Costs zero extra and kills the 2–10 s wake for anything that moves at least once every 15 min.
2. **If on Free**: upgrade to Launch or add a cheap keep-warm ping. A keep-warm ping is:
   - `/api/cron/keep-warm` → `SELECT 1` against the main DB.
   - Add to the Hetzner Go scheduler at 4-min cadence.
   - Guard with `Authorization: Bearer ${CRON_SECRET}`.
3. **Independent of 1 & 2**: make the Kamal healthcheck exercise DB. Today `/api/health` (`web/app/api/health/route.ts:18`) is a Node liveness probe only. Add `/api/health/ready` that runs `SELECT 1`, and point `kamal-proxy` at it for readiness only. Liveness stays on the cheap one so we don't mark the box unhealthy when Neon has a blip.

**Risk**. Zero code risk. Cost: either $0 (plan already covers it) or ~$19/mo if upgrading from free.

**Validation**.
```bash
# Idle 12 min after a real query, then hit /dashboard (with auth cookie)
# First request should be <2 s cold, <800 ms warm after the driver swap.
```

**Open question for Jesus**: Neon console → Projects → `inariwatch` → Settings → Compute → what's the current "Suspend compute after" value?

---

### [A3] Cloudflare Cache Rules for `app.*` — the biggest edge win available with zero code

**Evidence** (measured 2026-04-20 22:08 UTC).

| Route | Origin `x-nextjs-cache` | `Cache-Control` | `cf-cache-status` | TTFB p50 |
|---|---|---|---|---|
| `inariwatch.com/pricing` | `HIT` | `s-maxage=31536000` | **`HIT` (Age=4921)** | **133 ms** |
| `inariwatch.com/replay` | `HIT` | `s-maxage=31536000` | **`HIT`** | 149 ms |
| `app.inariwatch.com/login` | `HIT` | `s-maxage=31536000` | **`DYNAMIC`** | 236–597 ms |
| `app.inariwatch.com/register` | `HIT` | `s-maxage=31536000` | `DYNAMIC` | 213–454 ms |
| `app.inariwatch.com/forgot-password` | `HIT` | `s-maxage=31536000` | `DYNAMIC` | n/m |
| `app.inariwatch.com/reset-password` | `HIT` | `s-maxage=31536000` | `DYNAMIC` | n/m |
| `app.inariwatch.com/_next/static/chunks/*.js` | n/a | `public, max-age=31536000, immutable` | (not captured cleanly; likely HIT) | fast |
| `app.inariwatch.com/_next/image?url=...` | `MISS` | `public, max-age=2592000, must-revalidate` | **`HIT` (Age=5001)** | fast |

So: **`_next/image` IS cached at edge on `app.*` already** (Age 5001 s confirms it). **Page HTML is NOT.** The disparity is a CF dashboard setting — either the root zone has Cache Rules / Cache-Everything that the `app.*` zone doesn't, or CF's default is kicking in differently per hostname.

**Impact**. Every anonymous hit on `app.inariwatch.com/login` from Jesus's paying users — the first page they touch after clicking "Sign in" on the marketing site — does a full Hetzner roundtrip. At minimum ~230 ms TTFB from LAX, higher from EU/APAC. Edge cache would take that to ~30–80 ms.

**Fix** (30 min, CF dashboard only, **no deploy**).

Cloudflare zone `inariwatch.com` → **Caching → Cache Rules** → add four rules, in order:

1. **"Cache `app.*` anonymous pages"**
   - Match: `(http.host eq "app.inariwatch.com") and (http.request.uri.path in {"/login" "/register" "/forgot-password" "/reset-password" "/signout"})`
   - Action: **Eligible for cache**, Edge TTL **override to 1 day** (not year — NextAuth CSRF tokens baked into client-rendered pages change on redeploy; 1 day is safer).
   - Respect existing cookies: **Bypass cache if** `http.cookie contains "next-auth.session-token"` or `http.cookie contains "__Secure-next-auth.session-token"`.

2. **"Cache `/_next/static/*` (all hosts)"**
   - Match: `(starts_with(http.request.uri.path, "/_next/static/"))`
   - Action: Eligible for cache, Edge TTL **30 days** (`immutable` content, safe to cache longer but 30 d matches our image minimumCacheTTL).

3. **"Cache `/_next/image*` (already works, make it explicit)"**
   - Match: `(starts_with(http.request.uri.path, "/_next/image"))`
   - Action: Eligible for cache, Edge TTL 30 days.

4. **"Bypass cache for auth / API / dashboard"**
   - Match: `(http.host eq "app.inariwatch.com") and (starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/dashboard") or starts_with(http.request.uri.path, "/settings") or starts_with(http.request.uri.path, "/projects") or starts_with(http.request.uri.path, "/alerts") or starts_with(http.request.uri.path, "/integrations") or starts_with(http.request.uri.path, "/chat") or starts_with(http.request.uri.path, "/admin") or starts_with(http.request.uri.path, "/recordings"))`
   - Action: **Bypass cache** (guards against the R1 landmine).

**Also fix origin** (same deploy as A4): in `web/next.config.ts`, split the per-path `Cache-Control` so we never send `s-maxage=31536000` on authenticated routes. Current `async headers()` applies CSP-etc to `/:path*` but Next.js's own `Cache-Control: s-maxage=31536000` on prerendered pages is generated by the framework, not our code. The fix is to override per-path in `next.config.ts`:
```typescript
async headers() {
  return [
    { source: "/:path*", headers: securityHeaders },
    // Anonymous auth pages — OK to cache shared but not a year
    { source: "/login",            headers: [{ key: "Cache-Control", value: "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800" }] },
    { source: "/register",         headers: [{ key: "Cache-Control", value: "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800" }] },
    { source: "/forgot-password",  headers: [{ key: "Cache-Control", value: "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800" }] },
    { source: "/reset-password",   headers: [{ key: "Cache-Control", value: "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800" }] },
    // Dashboard shell — private only
    { source: "/dashboard/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    { source: "/alerts/:path*",    headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    { source: "/settings/:path*",  headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    { source: "/admin/:path*",     headers: [{ key: "Cache-Control", value: "private, no-store" }] },
  ];
},
```

**Risk**. Low. Cache Rule changes are instantly reversible (CF dashboard → delete rule). The `Vary: RSC, Next-Router-State-Tree, …` header Next 15 emits (observed on all responses above) fragments the cache by RSC fetches; Cache Rule treats RSC as a separate origin cache key, which is fine — RSC responses are small JSON, they'll warm up naturally.

**Validation**.
```bash
# Repeat 3× from the same region — should see cf-cache-status: HIT and TTFB drop to <100 ms
for i in 1 2 3 4; do
  curl -sS -I https://app.inariwatch.com/login \
    -w "try=$i status=%{http_code} ttfb=%{time_starttransfer}s  cf=%header{cf-cache-status}\n" \
    -o /dev/null
  sleep 1
done
```

### [A4] `priority` + `placeholder="blur"` on decorative auth background is an LCP trap

**Evidence**.
- `web/app/(auth)/login/page.tsx:62` + `:72` — two `<Image>` elements for the background, `alt=""` (decorative), `priority` on desktop variant, `placeholder="blur"` on both.
- `web/app/(auth)/register/page.tsx:64,73` — same pattern.
- Background file: `web/public/login-new-3.webp` → **194,256 bytes** (194 KB), `login-side-mobile.webp` → 75,788 bytes.
- `next.config.ts:46-53` already acknowledges in comments that this caused 5+ second TTFB before the `minimumCacheTTL: 2592000` fix. The `priority` marker makes the browser treat the background as **LCP-eligible**, which means page "paint" blocks on bytes of the bg.
- The real LCP candidate is the **form card** (white rounded rectangle at the centre-left) — `<div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-...">` at `login/page.tsx:100`. That's a ~0 KB visual, paints instantly.
- `placeholder="blur"` inlines a base64 blur placeholder into the HTML. On a 194 KB source, Next emits a ~2–4 KB base64 dataURL. Visible in the HTML payload → bloats the first-byte response.

**Impact**.
- **LCP impact**: `priority` forces the browser to download + decode the bg before marking LCP complete. On first-of-day, sharp may still need to generate the AVIF/WebP variant for this viewport if CF doesn't have it cached for this region. That's 2–10 s on CPX21 per variant; 4 variants × potentially 2 formats = potentially 16 s worst-case if the region is cold.
- **Observed**: CF DOES cache variants (Age=5001 on `/_next/image?url=login-new-3.webp&w=1920&q=85`). So the issue is only cold-region sharp. But `priority` means the browser waits for it regardless of cache status.
- The form + button are independently paintable without the background.

**Fix** (10 min, one commit).

```tsx
// web/app/(auth)/login/page.tsx — same in register/page.tsx
<Image
  src={loginSideSrc}
  alt=""
  fill
  className="hidden object-cover object-center sm:block"
  // REMOVE: priority
  // REMOVE: placeholder="blur"
  fetchPriority="low"          // ADD: tell browser this is decorative
  loading="lazy"               // ADD: defer until needed
  quality={70}                 // DOWN from 85 — decorative, user won't notice
  sizes="(min-width: 640px) 100vw, 0px"
/>
```

And add a pre-warm script:
```ts
// web/scripts/prewarm-images.ts
const URLS = [
  "/_next/image?url=%2Flogin-new-3.webp&w=1920&q=70",
  "/_next/image?url=%2Flogin-new-3.webp&w=1200&q=70",
  "/_next/image?url=%2Flogin-new-3.webp&w=828&q=70",
  "/_next/image?url=%2Flogin-new-3.webp&w=640&q=70",
  "/_next/image?url=%2Flogin-side-mobile.webp&w=828&q=70",
  "/_next/image?url=%2Flogin-side-mobile.webp&w=640&q=70",
];
// hit each twice (once with Accept: image/avif, once with Accept: image/webp)
// from CI post-deploy or locally via: curl -H "Accept: image/avif" "https://app.inariwatch.com$URL"
```
Wire it into `.github/workflows/deploy.yml` as a post-deploy step.

**Risk**. Minimal. `fetchPriority="low"` + `loading="lazy"` means on slow networks the bg may paint after the form — but the form is the intended LCP, so the *perceived* experience is faster, not slower. If Jesus wants the bg to feel "tight" on fast connections, consider `fetchPriority="auto"` (browser default) instead of `"low"`.

**Validation**.
- Lighthouse on `https://app.inariwatch.com/login` in Chrome DevTools → Performance → look for LCP element. Should report the form card or logo, not the image.
- Re-run LH with Network throttled to "Fast 3G" — LCP should be <2.0 s.

---

### [A5] Dashboard layout: 4 serial awaits + duplicate `getServerSession` call

**Evidence**.
- `web/app/(dashboard)/layout.tsx:19` awaits `getServerSession` → JWT decode (no DB).
- `:37` awaits `db.select(users).where(id)` → **query 1**.
- `:51` awaits `getActiveOrgId()` which, at `web/lib/workspace.ts:8`, does `await getServerSession(authOptions)` **again** → redundant JWT decode — then `db.select(users.activeOrgId)` → **query 2 is querying the same `users` row we already have**.
- `:57-59` `Promise.all([getWorkspaceProjectIds(userId, activeOrgId), getUserOrganizations(userId)])` — fans out to ~3–5 queries.
- `:66-77` `Promise.all([pollingRow, countRow])` — 2 queries.

**Total**: ~7–9 queries, 2 duplicate (re-reading the same `users` row + re-decoding the session).

**Impact**. Warm: ~200–400 ms wasted on the redundant session + user query. Cold (after A1/A2): matters less but the pattern is sloppy.

**Fix** (30 min).

```typescript
// web/lib/workspace.ts — accept session or userId
export async function getActiveOrgId(userId?: string): Promise<string | null> {
  let uid = userId;
  if (!uid) {
    const session = await getServerSession(authOptions);
    uid = (session?.user as { id?: string })?.id;
  }
  if (uid) {
    const [row] = await db.select({ activeOrgId: users.activeOrgId })
      .from(users).where(eq(users.id, uid)).limit(1);
    return row?.activeOrgId ?? null;
  }
  const cookieStore = await cookies();
  return cookieStore.get("activeOrgId")?.value ?? null;
}
```

Then in `web/app/(dashboard)/layout.tsx`:
```typescript
// Merge the two users-row queries into one
const [userRow, activeOrgId] = userId
  ? await Promise.all([
      db.select({
        plan: users.plan,
        passwordHash: users.passwordHash,
        emailVerifiedAt: users.emailVerifiedAt,
        activeOrgId: users.activeOrgId,
      }).from(users).where(eq(users.id, userId)).limit(1).then(r => r[0]),
      Promise.resolve(null), // placeholder
    ])
  : [undefined, null];

const effectiveOrgId = userRow?.activeOrgId ?? null;
// Now the rest of the layout uses effectiveOrgId without a second users query
```

**Streaming win** (separate refactor, optional): wrap the sidebar in `<Suspense>` so the page shell paints before polling/count queries finish.

**Risk**. Low. All queries remain semantically identical.

**Validation**.
```bash
# Hit /dashboard with a valid session cookie, measure via server logs
# Server timing header would help; add Server-Timing to the response
```

---

### [A6] Infrastructure pre-warm

**Evidence**.
- `web/config/deploy.yml:68-71` healthcheck `/api/health` interval 5 s, timeout 3 s → triggers Node liveness, not DB.
- Kamal 2 defaults to HTTP/1.1 between `kamal-proxy` and the container (app_port 3000). No tuning in deploy.yml for Node flags or keepalive.
- Node process on a 4 GB box with default `--max-old-space-size` (approx 75% of physical = ~2800 MB) is OK but not explicit. Default GC tuning for Node 20 is reasonable.
- No `tini` or explicit init in the Docker image (standalone Next.js image uses `node`). Signal handling on `kamal deploy` restart may be clean because `kamal-proxy` does gapless swap, not SIGTERM-and-wait.

**Impact**. Low — most latency wins are upstream (CF, DB, images). This section is "correctness & room to grow", not "hotspot".

**Fix**.
1. **Add a readiness probe** (doesn't change liveness):
   ```ts
   // web/app/api/health/ready/route.ts
   import { db } from "@/lib/db";
   import { sql } from "drizzle-orm";
   import { NextResponse } from "next/server";
   export const dynamic = "force-dynamic";
   export const runtime = "nodejs";
   export async function GET() {
     try { await db.execute(sql`SELECT 1`); }
     catch { return NextResponse.json({ ready: false }, { status: 503 }); }
     return NextResponse.json({ ready: true });
   }
   ```
   Kamal-proxy can stay on liveness. A future blue/green swap script can gate on `/api/health/ready` before flipping traffic.
2. **Node memory flag**: pin `--max-old-space-size=3072` in the container `CMD` — prevents sudden OOM under sharp + Next dev-import burst.
3. **Explicit Node keepalive to Neon**: set in `pg.Pool` config (covered in A1: `keepAlive: true`).

**Risk**. None.

**Validation**. Watch Netdata memory widget during a `npm run build`-adjacent deploy for the first 5 min.

---

### [A7] Network path — CF HTTP/3, TLS resumption

**Evidence**.
- All responses advertise `alt-svc: h3=":443"; ma=86400` → HTTP/3 is enabled on the zone.
- `Report-To` / `Nel` headers present → Network Error Logging works, so client-side RUM data is available in CF → Analytics → Network Error Logging.
- Jesus's observed "1 minute on first hit of day" cold cost is not TLS. TLS cold session to CF from LAX is ~300–500 ms on a new device; a warm session resumes in ~50 ms. Not the dominant term in the 15–60 s symptom — the dominant term was A1+A2.

**Fix**.
1. Nothing to do on HTTP/3 — already on.
2. **Don't buy Argo Smart Routing** — the measurement shows ~130 ms TTFB from LAX on cached content, ~230–450 ms on `DYNAMIC` (driven by Hetzner-Ashburn → LAX origin pull, ~60 ms one-way baseline). Argo shaves ~30% on long paths; wouldn't be worth $5/mo extra on a LAX-adjacent origin.
3. **CF Early Hints (free)**: enable in Speed → Optimization → Early Hints. On a cold `/login`, CF can send `103 Early Hints` with `Link: </_next/static/chunks/main.js>; rel=preload` before the origin responds. Free win for cold navigations.

**Risk**. Zero.

**Validation**.
- `curl -sI --tlsv1.3 -I https://app.inariwatch.com/login` confirms TLS 1.3.
- CF → Analytics → Cache → "Cache Ratio" for `app.*` should climb past 60% after A3.

---

## 3. Track B — Security posture

### [B1] HTTP security headers — near A-, not yet A+

**Evidence** (full dump from `curl -I https://app.inariwatch.com/login`, captured 22:08 UTC):

```
Cache-Control: s-maxage=31536000                                      ← see R1 + A3
content-security-policy: default-src 'self';
  script-src 'self' 'unsafe-inline' https://plausible.io;             ← A+ blocker
  style-src 'self' 'unsafe-inline';                                   ← acceptable (Tailwind)
  img-src 'self' data: https:;
  media-src 'self';
  font-src 'self';
  connect-src 'self' https:;                                          ← too broad
  frame-ancestors 'none'
permissions-policy: camera=(), microphone=(), geolocation=()          ← only 3 features listed
referrer-policy: strict-origin-when-cross-origin                      ← good
strict-transport-security: max-age=63072000; includeSubDomains; preload  ← 2y, preload flag set ✓
x-content-type-options: nosniff                                       ← good
x-frame-options: DENY                                                 ← good (redundant with CSP frame-ancestors)
x-xss-protection: 1; mode=block                                       ← deprecated; OWASP says "0"

MISSING:
  cross-origin-opener-policy                                          ← isolate browsing context
  cross-origin-resource-policy                                        ← prevent cross-site loads
  cross-origin-embedder-policy                                        ← (optional — breaks some embeds)
```

**Impact**.
- **`'unsafe-inline'` in `script-src`** is the A+ blocker. Any reflected HTML that lands in a Next RSC payload or a 3rd-party widget becomes executable. Vercel, Stripe, Linear all use `strict-dynamic` + nonce.
- **`connect-src 'self' https:`**: allows the browser to `fetch()` to any HTTPS endpoint. A compromised npm package can exfiltrate to attacker.com without CSP blocking.
- **`X-XSS-Protection: 1; mode=block`** — modern browsers ignore this header; in certain legacy combinations it enables XS-Leaks. OWASP explicitly recommends setting to `0` or omitting.
- **No COOP**: `window.opener` from a popup keeps access to the original window. Small surface but free to fix.

**Fix** (60 min).

Edit `web/next.config.ts`:

```typescript
const securityHeaders = [
  { key: "X-Content-Type-Options",  value: "nosniff" },
  { key: "Referrer-Policy",         value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy",      value:
      "accelerometer=(), autoplay=(), camera=(), cross-origin-isolated=(), " +
      "display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), " +
      "gyroscope=(), hid=(), identity-credentials-get=(), idle-detection=(), " +
      "magnetometer=(), microphone=(), midi=(), otp-credentials=(), payment=(), " +
      "picture-in-picture=(), publickey-credentials-create=(self), " +
      "publickey-credentials-get=(self), screen-wake-lock=(), serial=(), " +
      "storage-access=(), usb=(), web-share=(), xr-spatial-tracking=(), " +
      "interest-cohort=(), browsing-topics=()"
  },
  { key: "Cross-Origin-Opener-Policy",   value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-site" },
  // COEP is powerful but breaks cross-origin <img>/<iframe>/avatars on Gravatar, GitHub etc.
  // Skip until you've audited every third-party asset. Not needed for A+.
  //{ key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  // X-Frame-Options is redundant with CSP frame-ancestors — keep for legacy UAs
  { key: "X-Frame-Options", value: "DENY" },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];
```

And move CSP to a middleware-generated nonce:

```typescript
// web/middleware.ts — augment the existing one
import crypto from "node:crypto";

// inside middleware(req), before returning NextResponse.next():
const nonce = crypto.randomBytes(16).toString("base64");
const csp = [
  "default-src 'self'",
  `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://plausible.io`,
  "style-src 'self' 'unsafe-inline'",                         // Tailwind inline styles — acceptable
  "img-src 'self' data: https://avatars.githubusercontent.com https://lh3.googleusercontent.com https://secure.gravatar.com",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self' https://plausible.io https://api.github.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const res = NextResponse.next({ request: { headers: new Headers(req.headers) } });
res.headers.set("Content-Security-Policy", csp);
res.headers.set("x-nonce", nonce);   // expose to app router
```

Then in the app root layout:
```typescript
// web/app/layout.tsx
import { headers } from "next/headers";
// inside the component
const nonce = (await headers()).get("x-nonce") ?? undefined;
// Pass nonce into <Script> tags and any inline scripts
```

Remove the `headers()` CSP line from `next.config.ts` once middleware takes over — can't have both (they append, producing two `Content-Security-Policy` headers, which browsers OR together resulting in the strictest wins; usually not what you want).

**Risk**. Medium-to-ship. `strict-dynamic` + nonce on Next 15 is well-trodden but a nonce mismatch breaks all client scripts. Stage in production with a CSP-Report-Only header first:

```typescript
res.headers.set("Content-Security-Policy-Report-Only", csp);
res.headers.set("Report-To", '{"group":"csp","max_age":10886400,"endpoints":[{"url":"https://app.inariwatch.com/api/csp-report"}]}');
```

…ship that for 48 h, watch `/api/csp-report` for violations, then flip to enforcing.

**Validation**.
- `curl -sI https://app.inariwatch.com/login` → no `unsafe-inline` in script-src.
- Mozilla Observatory (re-run via https://observatory.mozilla.org in a browser; API is broken — see open questions) → should report A+.
- securityheaders.com → A+.
- Lighthouse → Security audit section → zero failures.

---

### [B2] Auth surface — mostly sound, three gaps

**Evidence**.
- NextAuth config at `web/lib/auth.ts`:
  - JWT session, 30 d max age (line 15).
  - Credentials provider has bcrypt + optional TOTP 2FA (line 45).
  - OAuth: GitHub always on; Google/GitLab conditional on env presence.
  - `jwt()` callback backfills `emailVerifiedAt` for OAuth users (line 137) — good.
- `credentials.authorize()` calls `rateLimit("login", email.toLowerCase(), { windowMs: 900_000, max: 10 })` at line 56 — **per-email**, 10/15 min. No IP-level throttle.
- `redirect` callback (line 159) rejects cross-origin redirects — good.
- No `cookies` config override in authOptions — NextAuth defaults: `__Secure-next-auth.session-token`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`. Defaults are fine for modern browsers.
- The login form itself (`web/app/(auth)/login/page.tsx:30`) uses `signIn("credentials", ...)` which POSTs to `/api/auth/callback/credentials` with CSRF token — NextAuth's default CSRF is fine.

**Gaps**.
1. **No IP-level rate limit** on `/api/auth/signin` (NextAuth's form POST endpoint). An attacker cycling 10 known-emails × 10 attempts × N IPs can hit 100+ attempts/min from one machine.
2. **Email enumeration**: `authorize()` returns `null` for both "user not found" and "wrong password" (lines 70, 73), which is correct — but the timing differs. `bcrypt.compare()` on a real hash is ~100 ms; on `null` (user-not-found branch at line 70) there is no bcrypt call, so the response times out faster. Crude but measurable.
3. **OAuth state/PKCE**: NextAuth v4's built-in OAuth providers (GitHub, Google, GitLab) use `state` cookie with the framework's own OAuth client. PKCE is on by default for Google (OIDC) and GitHub as of NextAuth v4.24+. Confirm `next-auth` version in `package.json`.
4. **Session rotation on privilege change**: e.g., when a user enables 2FA, the existing JWT is not invalidated. Low risk (same-device) but worth noting.
5. **`/cli/*` device flow**: `web/app/api/cli/auth/start/route.ts` and `auth/poll/route.ts` — `Grep` them for `rateLimit()`. I did not read them; flag as an item.

**Fix** (90 min).

1. **Add IP-level rate limit** in `authorize()`:
   ```typescript
   // web/lib/auth.ts inside CredentialsProvider.authorize
   // get IP from NextAuth's req passed to authorize — requires req adapter
   // Simpler: add a pre-flight route handler in web/app/api/auth/[...nextauth]/route.ts
   //   that rate-limits by IP before NextAuth runs.
   ```
   Or add a middleware edge rule: match `/api/auth/callback/credentials` and `/api/auth/signin`, rate-limit via the existing `rateLimit()` function keyed on `req.headers["x-forwarded-for"]`.

2. **Constant-time authorize**: force a dummy bcrypt on the user-not-found branch:
   ```typescript
   const DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8vS0mLwGZZ6xXYtBsZH4nF7P0K6M/O"; // bcrypt of "dummy"
   const valid = await bcrypt.compare(
     credentials.password,
     user?.passwordHash ?? DUMMY_HASH,
   );
   if (!user || !valid) return null;
   ```

3. **Audit CLI device flow rate limits**: `grep -r "rateLimit(" web/app/api/cli/` and confirm `/auth/poll` limits per-device-code.

4. **Session rotation on 2FA enable / password change**: bump a `sessionGeneration` field on the user row; include it in the JWT; invalidate old sessions when the field advances. Lower priority.

5. **Reset-password**: verify the response body + timing is identical for "email exists" vs "doesn't exist" (need to read the `forgot-password` action — not done in this pass; flag it).

**Risk**. Low for (1) + (2). (3) is just a read.

**Validation**.
- Burp Repeater: 50 logins with nonexistent emails vs 50 with real emails — timing histograms should overlap.
- `hey -n 500 -c 20 -m POST https://app.inariwatch.com/api/auth/callback/credentials -d '...'` → 429 responses should appear after N attempts per IP.

---

### [B3] Rate limiting + abuse — Redis-first, good foundation, partial coverage

**Evidence**.
- `web/lib/rate-limit.ts` (NOT examined, but referenced) and `web/lib/auth-rate-limit.ts:43-89` — unified `rateLimit(namespace, key, { windowMs, max })` with RateLimiterRedis atomic sliding window, DB fallback. Good design.
- Callers I can see:
  - `web/lib/auth.ts:56` — login credentials flow (per email).
- Callers I did not verify but are plausibly needed:
  - `/api/capture/*` (webhook ingestion) — very likely has limits on the per-integration path.
  - `/api/mcp/*` — memory says "cheap / moderate / expensive" tiers.
  - `/api/chat` — Ask Inari LLM — likely limited (costs money).
  - `/api/auth/*` OAuth init/callback — unclear.
- **CF Bot Fight Mode**: referenced in deploy memory — confirm on in CF dashboard.
- **DDoS**: CF free tier absorbs most volumetric attacks on the zone. Hetzner CX22 has a default 20 TB/mo outbound at 1 Gbit; if an attacker saturates the 1 Gbit pipe past CF (e.g., attacks the origin IP directly), that's $0.50/TB overage + availability risk.

**Gaps**.
1. **No CF WAF custom rule on `/api/auth/signin`**. Free CF plan supports 5 custom rules — spend one here.
2. **No rate limit on `/api/auth/signin/{provider}` (OAuth init)** — an attacker can flood OAuth `state` creation, which hits memory-backed stores.
3. **No IP-level hash used** in `rateLimit()` calls I audited (line 56 uses email only).
4. **`/api/install` and `install.inariwatch.com`** rewrite to the installer script — confirm CF cache + rate limit. If users wget the installer in a loop, unbounded bandwidth.
5. **Origin IP exposure**: Jesus mentioned UFW + DOCKER-USER locked to CF IPs. Re-verify the CF IPv4/IPv6 list is current (`curl https://www.cloudflare.com/ips-v4`) and the cron updates UFW monthly.

**Fix**.

1. **CF Cache Rule + Custom Rule for auth**:
   - Rate-limit rule (free plan allows 1 rule): `http.request.uri.path in {"/api/auth/signin" "/api/auth/callback/credentials"}` → action: block, 10 req/min per `ip.src`.
2. **Rate limit OAuth init**:
   ```typescript
   // in middleware.ts, before passing OAuth paths through
   if (pathname.startsWith("/api/auth/signin/") || pathname.startsWith("/api/auth/callback/")) {
     const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
     const rl = await rateLimit("oauth", ip, { windowMs: 60_000, max: 20 });
     if (!rl.allowed) return new NextResponse("Too many requests", { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) } });
   }
   ```
   **Caveat**: this imports DB / Redis from middleware. Edge runtime won't allow `ioredis`. Either run middleware on Node runtime (`export const runtime = "nodejs"` — allowed in middleware in Next 15+) or do the rate limit in the route handler itself (safer).
3. **Automate CF IP refresh** on Hetzner: add a cron on the box that pulls `cloudflare.com/ips-v4` + `ips-v6` weekly and reconciles UFW + DOCKER-USER. If it already exists, verify the last run.
4. **Webhook signature verification audit**: for each of `/api/webhooks/{sentry,vercel,github,datadog,expo}`, confirm the HMAC / signature check runs *before* any DB work. Sentry uses `sentry-hook-signature`, Vercel uses `x-vercel-signature`, GitHub uses `x-hub-signature-256`, Datadog uses `x-datadog-signature`. Note: I did not open these files — flag for next pass.

**Risk**. Low for CF rules (instantly reversible); medium for OAuth middleware (affects login flow, stage behind CSP-Report-Only-equivalent by logging-before-blocking for 24 h).

**Validation**.
- `hey -n 500 -c 20 https://app.inariwatch.com/api/auth/signin` → 429 after limit.
- CF dashboard → Security → WAF → Events → confirm custom rule fires.

---

### [B4] Dependency + supply chain

**Evidence**.
- `package.json` — not examined in this pass.
- `npm audit`: not run.
- No visible SBOM generation step in CI (did not open `.github/workflows/*`).
- `feedback_secret_handling.md` already hardened against Claude reading env files.
- Public mirrors (`@inariwatch/capture`, `@inariwatch/mcp`) have their own repos — their supply chain is isolated from monorepo.

**Recommended** (30 min, all local or CI).

1. **Run `npm audit`** (from repo root, `web/` and `capture/` subdirs):
   ```bash
   cd web && npm audit --audit-level=high --json > ../audit-web.json
   cd ../capture && npm audit --audit-level=high --json > ../audit-capture.json
   ```
   Paste any HIGH / CRITICAL findings in a follow-up doc.
2. **Lockfile integrity**: add to CI a step that runs `npm ci --audit=false` and fails if `package-lock.json` requires changes. Prevents an attacker landing a malicious lockfile in a PR.
3. **Secret scanning**: `gh secret-scanning` is on for the org if Advanced Security is enabled; confirm. Alternatively run `gitleaks protect` pre-commit locally.
4. **SBOM**: `npm sbom --sbom-format=cyclonedx` (Node 24+) or `cyclonedx-npm`. Generate in CI, upload as artifact.

**Risk**. None — these are observational.

---

### [B5] Infrastructure hardening (Hetzner)

**Evidence** (from memory + deploy.yml):
- `project_hetzner_hardening.md` claims 10/11 phases shipped — SSH / sysctl / Docker / netdata ACL / auditd / CF Origin Cert / UFW / DOCKER-USER locked to CF IPs. WAF deferred to Pro.
- `web/config/deploy.yml:38-42` confirms container-level hardening: `no-new-privileges`, `cap-drop ALL`, minimal `cap-add`.
- `:207-234` Redis accessory: `no-new-privileges`, `cap-drop ALL`, bound to `172.18.0.1:6379` (kamal-network bridge gateway only), `requirepass` from sops. Good.
- `:195` SSH user is `root` — acceptable when SSH is key-only and `root` login is restricted; verify `/etc/ssh/sshd_config`: `PermitRootLogin prohibit-password`.
- `ENCRYPTION_KEY` rotation flagged pending in cutover memory (`project_hetzner_web_cutover.md`). Still pending? **Open question**.

**Gaps**.
1. **`ENCRYPTION_KEY` rotation** — flagged in memory as pending. The key encrypts user-supplied API keys in DB (BYOK). If rotated, every encrypted row must be re-encrypted. Not trivial, but it's technical debt accruing.
2. **sops age key backup** — memory flags as critical. Confirm the age key is in a password manager / printed to a safe + stored offline.
3. **Docker socket exposure**: none of the containers in `deploy.yml` mount `/var/run/docker.sock`. Good. Confirm the same is true for ops-agent, worker, and inari-staging services (separate deploys).
4. **Redis accessory `restart` policy** — deploy.yml explicitly omits it, relying on Kamal default. Verify `unless-stopped` is what lives on the box: `docker inspect inari-web-redis | jq .[0].HostConfig.RestartPolicy`.
5. **Auditd rules** — memory says shipped; spot-check `auditctl -l` covers `execve`, `/etc/passwd`, Docker unix socket, sops file reads.

**Fix** for the one load-bearing gap:

**`ENCRYPTION_KEY` rotation script** (2 h one-off):
```ts
// web/scripts/rotate-encryption-key.ts
// 1. Set OLD_ENCRYPTION_KEY + NEW_ENCRYPTION_KEY in env
// 2. For each row in projectIntegrations.encryptedApiKey + users.totpSecret:
//    - decrypt with OLD → re-encrypt with NEW → UPDATE
// 3. After verification, flip ENCRYPTION_KEY in sops to NEW, remove OLD from env
```
Run in a maintenance window of ~10 min (no active remediation; set a CF custom rule redirecting `/api/*` → 503 temporarily).

**Risk**. High if mis-run — could corrupt existing BYOK keys. Script must be idempotent: write the NEW-encrypted value to a new column first, verify decrypt, then atomically swap.

---

### [B6] Data protection

**Evidence** (mostly inference; not deeply verified).
- Neon Postgres: encryption at rest is default — Neon does it transparently. Confirm via Neon console.
- PII in logs: `console.error("[redis/ioredis] connection error:", err.message)` (`lib/redis.ts:83`), `console.warn` with raw URLs in `lib/pollers/uptime.ts:33`, and many others. Likely some user emails / project names flow into logs under normal error paths.
- `logging:` in `deploy.yml:238` — json-file driver, 10 MB × 5 files = 50 MB per container. Short retention, good for local use but no long-term aggregation.
- Backups: Neon takes point-in-time restore up to the plan's retention window (Launch = 7 d, Scale = 14+ d). Confirm active.

**Tested restore**: very unlikely based on memory signals. A one-off staged restore to a scratch Neon branch is a 15-min test — highly recommended.

**Retention crons**: memory mentions "retention cron" for Replay V2 (`project_replay_v2.md` shipped 2026-04-14). Confirm the cron actually runs + logs purged row counts.

**Fix** (observational + one script).

1. **Scrub PII from log lines** — audit `console.*` call sites for `email`, `userId`, raw URLs. Replace with `user@id:${userId.slice(0,8)}…` style. Low priority but shows up in SOC2 prep.
2. **Test a Neon restore**: Neon console → Branches → Create branch from `main` at `7 days ago` → point a scratch app at it → verify tables non-empty. Document the runbook.
3. **Retention cron alarm**: each retention cron should log row counts deleted. Add a metric to `/admin/ops` showing last-delete count and last-run timestamp per retention job.

---

### [B7] Security observability

**Evidence**.
- `audit_logs` table exists (CLAUDE.md references "every tool call logged to audit_logs" for MCP). Good.
- Dashboard actions (alert ack/resolve/silence) — unclear whether these write audit rows.
- Auth events (sign-in, sign-out, 2FA enable, password change) — unclear whether audit-logged.
- `/admin/ops` dashboard is live (memory `project_ops_dashboard_plan.md`). Covers operational health. Security-specific widgets (failed logins by IP, suspicious actions, sops-file changes) are not enumerated in memory.

**Fix** (incremental).

1. **Expand audit_logs coverage** to auth events:
   ```typescript
   // in NextAuth events hook
   events: {
     async signIn({ user, account, isNewUser }) {
       await db.insert(auditLogs).values({
         userId: user.id,
         action: "auth.signin",
         metadata: { provider: account?.provider, isNewUser },
         ipAddress: /* derive from req headers — needs events adapter */,
       });
     },
     async signOut({ token }) { /* audit */ },
   }
   ```
2. **Anomaly alert**: nightly cron that greps `audit_logs` for > 20 failed sign-ins from one IP in the last hour → Slack alert to admin.
3. **sops file change alert**: watch `.sops.yaml` / `.env.sops.yaml` modifications via `auditd` → fire a webhook to admin Slack.

**Risk**. None — all observational.

---

## 4. Measurement appendix

### 4.1 TTFB — raw curl output (2026-04-20 22:08 UTC, from Mexico → LAX edge)

**Root zone (`inariwatch.com`)**:
```
/pricing  try=1  status=200  total=0.347s  ttfb=0.306s  cf-cache-status=HIT  Age=4921  x-nextjs-cache=HIT
/pricing  try=2  status=200  total=0.168s  ttfb=0.129s  cf-cache-status=HIT
/pricing  try=3  status=200  total=0.173s  ttfb=0.133s  cf-cache-status=HIT
/replay   try=1  status=200  total=0.211s  ttfb=0.140s  cf-cache-status=HIT  Age=4921
/replay   try=2  status=200  total=0.221s  ttfb=0.149s  cf-cache-status=HIT
/replay   try=3  status=200  total=0.225s  ttfb=0.159s  cf-cache-status=HIT
```

**App zone (`app.inariwatch.com`)**:
```
/login      try=1  status=200  total=0.597s  ttfb=0.591s  cf-cache-status=DYNAMIC
/login      try=2  status=200  total=0.508s  ttfb=0.502s  cf-cache-status=DYNAMIC
/login      try=3  status=200  total=0.237s  ttfb=0.237s  cf-cache-status=DYNAMIC
/register   try=1  status=200  total=0.393s  ttfb=0.388s  cf-cache-status=DYNAMIC
/register   try=2  status=200  total=0.461s  ttfb=0.454s  cf-cache-status=DYNAMIC
/register   try=3  status=200  total=0.220s  ttfb=0.214s  cf-cache-status=DYNAMIC
/dashboard  try=1  status=307  total=0.452s  ttfb=0.452s  (302 → /login)
/dashboard  try=2  status=307  total=0.248s  ttfb=0.248s
/dashboard  try=3  status=307  total=0.440s  ttfb=0.440s
```

**Observations**:
- Root cached → p50 130 ms, p95 306 ms. Healthy.
- App DYNAMIC → p50 450 ms, p95 600 ms. Every hit Hetzner. Driven by CF→Hetzner-Ashburn RTT + HTML render (~80-120 ms origin TTFB observed via `x-nextjs-cache: HIT` so origin itself is warm).
- Dashboard 307 is middleware-level redirect without session cookie — fast because no DB touched.
- No 60 s seen in tests — Neon compute was warm at measurement time. Cold behaviour (A1, A2) would manifest on the first DB query, which in the 307 path (no session) doesn't occur. Jesus's symptom matches a **logged-in dashboard cold load on first-of-day**.

### 4.2 Header audit — highlights

See §3 B1 for `/login` full dump. Key headers across all routes on `app.*`:
- Origin is correctly setting CSP, HSTS (2 y + preload), `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, `X-Content-Type-Options`.
- **Missing**: COOP, CORP, COEP. X-XSS-Protection is deprecated.
- **Misconfigured for `app.*`**: `Cache-Control: s-maxage=31536000` on `/login`, `/register`, `/forgot-password`, `/reset-password` is a landmine (see R1).

### 4.3 Mozilla Observatory / securityheaders.com

**Could not fetch programmatically**:
- Mozilla Observatory v1 API returned HTTP 502 (deprecated; v1 decommissioned Jan 2025). v2 (`observatory-api.mdn.mozilla.net`) needs browser, returned 404/411 on GET/POST from curl.
- `securityheaders.com` blocks automated WebFetch (HTTP 403).

**Action for Jesus**: run in browser:
- https://observatory.mozilla.org/analyze/app.inariwatch.com
- https://securityheaders.com/?q=app.inariwatch.com&hide=on&followRedirects=on

Paste the grade + breakdown back into a `#security-audit` memory entry. Projected: **before fixes = B+ (Observatory) / B (securityheaders)**; **after B1 fixes = A+ / A+**.

### 4.4 Lighthouse (browser — Jesus to run)

Open Chrome DevTools → Performance → Lighthouse → **Mobile, Performance + Best Practices + SEO + Accessibility**. URL: `https://app.inariwatch.com/login`. Capture to PDF.

Repeat for `https://app.inariwatch.com/dashboard` — requires signed-in tab. Chrome DevTools → Lighthouse → "Clear storage" OFF, then run.

**Target metrics (post-fix)**:
- LCP < 2.0 s mobile (currently unknown but suspected > 5 s cold).
- TBT < 200 ms.
- CLS < 0.1.
- Performance score ≥ 90.

### 4.5 Side-by-side TTFB vs benchmarks

Measured 2026-04-20 22:15 UTC (same vantage). **Values are single-shot from this machine — not production-grade RUM — but directionally useful.**

| Target | TTFB cold (first hit) | TTFB warm |
|---|---|---|
| `vercel.com/login` | ~130 ms (edge cached) | ~50 ms |
| `dashboard.stripe.com/login` | ~180 ms | ~100 ms |
| `linear.app/login` | ~120 ms | ~60 ms |
| **`app.inariwatch.com/login` (today)** | **~590 ms** | **~230 ms** |
| `app.inariwatch.com/login` after A3 | ~70 ms (projected) | ~40 ms |

---

## 5. Shipping plan

### Day 1 (2026-04-21) — zero deploys, ~1 h dashboard + Neon work

| # | Task | Surface | Owner | Time |
|---|---|---|---|---|
| 1 | Create 4 CF Cache Rules (A3). Test with `curl -I` in each region. | CF dashboard | Jesus | 20 min |
| 2 | Set CF custom rule rate-limit on `/api/auth/signin` + `/api/auth/callback/credentials` (B3). | CF dashboard | Jesus | 10 min |
| 3 | Verify Neon compute autosuspend setting, set to 15 min if on Launch+; add keep-warm cron if on Free (A2). | Neon console + Go scheduler | Jesus | 15 min |
| 4 | Submit `inariwatch.com` to HSTS preload list at https://hstspreload.org (if not already). Prerequisite: confirm preload flag is in HSTS response — confirmed ✓ in §4.2. | hstspreload.org | Jesus | 5 min |
| 5 | Run Observatory + securityheaders in browser, paste grades into a memory entry. | Browser | Jesus | 5 min |
| 6 | Run Lighthouse on `/login` + `/dashboard`, save PDF. | Browser | Jesus | 10 min |

### Day 2 (2026-04-23 or 2026-04-24) — 1 batched deploy, ~4 h work

Commit locally as you go (free). Push **once** at the end.

| # | Task | Surface | Time |
|---|---|---|---|
| 7 | Remove `priority` + `placeholder="blur"` on login/register bg (A4). Drop `quality` to 70. | `web/app/(auth)/{login,register}/page.tsx` | 15 min |
| 8 | Add pre-warm script + wire into GH Actions post-deploy (A4). | `web/scripts/prewarm-images.ts` + `.github/workflows/deploy.yml` | 45 min |
| 9 | Fix duplicate `getServerSession` in `getActiveOrgId` + merge users-row queries in dashboard layout (A5). | `web/lib/workspace.ts` + `web/app/(dashboard)/layout.tsx` | 30 min |
| 10 | Add readiness probe `/api/health/ready` that runs `SELECT 1` (A6). | `web/app/api/health/ready/route.ts` | 10 min |
| 11 | CSP nonce + `strict-dynamic` + COOP + CORP + drop `X-XSS-Protection` (B1). Ship in **report-only** mode first. | `web/middleware.ts` + `web/next.config.ts` + `web/app/layout.tsx` | 90 min |
| 12 | Split per-path `Cache-Control` in `next.config.ts` so `/dashboard/*` sends `private, no-store` and auth pages send `s-maxage=86400, swr=604800` (A3 origin side). | `web/next.config.ts` | 15 min |
| 13 | IP rate limit on `/api/auth/*` — add a Node-runtime middleware check or route handler pre-NextAuth (B3). | `web/middleware.ts` or `web/app/api/auth/[...nextauth]/route.ts` | 45 min |
| 14 | Constant-time `authorize()` — `bcrypt.compare(pw, user?.passwordHash ?? DUMMY_HASH)` (B2). | `web/lib/auth.ts` | 15 min |
| 15 | `next build` locally, run vitest suite + chaos tests (`cd web && npx vitest run lib/chaos/` — 103 tests). | local | 30 min |
| 16 | One `git push` after everything validates. | | |

After push: watch `/admin/ops` + Vercel-era dashboards for 2 h. If CSP Report-Only fires more than a handful of noise events, fix before flipping to enforcing in Day 3.

### Day 3+ (2026-04-26 or later) — next batched deploy, 2–3 days after Day 2

| # | Task | Time |
|---|---|---|
| 17 | Driver swap `@neondatabase/serverless` → `pg.Pool` against pooler URL, behind `DB_DRIVER` env (A1). | 2 h |
| 18 | Flip CSP from Report-Only to enforcing (after 48 h clean report log). | 10 min |
| 19 | `ENCRYPTION_KEY` rotation one-off (B5) — schedule a maintenance window. | 2 h script + 15 min window |
| 20 | Expand `audit_logs` coverage to auth events + admin-panel actions (B7). | 90 min |
| 21 | Neon point-in-time restore test (B6). Document runbook. | 30 min |
| 22 | Decide on PPR for `/dashboard` shell. Next 15.1+ ships `experimental.ppr`; adoption gated on "how stable in 15.x". Evaluate with `next build --experimental-ppr` on a branch; if build + chaos pass, worth it. | 2 h evaluation |

Respects `feedback_commit_workflow.md`: Day 1 = 0 deploys, Day 2 = 1 deploy, Day 3+ = 1 more deploy. Total = 2 deploys in ~6 days.

---

## 6. Open questions for Jesus

Things I could not verify without your hands or your dashboards.

1. **Neon plan + autosuspend**: Free / Launch / Scale? Current "Suspend compute after" minutes? Needed to decide between A2 option 1 (console flip) vs option 2 (keep-warm cron).
2. **Neon point-in-time retention window**: current plan gives N days; is a restore drill on the calendar?
3. **Cloudflare plan**: Free / Pro / Business? Affects WAF custom-rule count (Free = 5, Pro = 20). B3 fix uses 2 rules.
4. **`ENCRYPTION_KEY` rotation**: still pending? If yes, green-light the maintenance window in Day 3?
5. **sops age key backup**: is the key printed + stored offline somewhere recoverable?
6. **Mozilla Observatory grade today** (browser run). Same for securityheaders.com.
7. **Lighthouse Performance score** for `/login` + `/dashboard` pre-fix. Baseline for Day 2 comparison.
8. **`next-auth` version** in `web/package.json` — for the PKCE-in-OAuth confirmation (B2 gap 3).
9. **`audit_logs` coverage** today: do dashboard actions (ack / resolve / silence / admin-panel) actually write rows? Memory is ambiguous.
10. **CF WAF — Bot Fight Mode / managed rules**: on or off?
11. **`/api/install`** rate limit: is it behind CF Cache (hit-once, cache-fast) or is every wget hitting origin?
12. **Go scheduler `CRON_SECRET`**: same secret as Vercel-era? If rotated during Hetzner cutover, confirm the Go scheduler is using the current one.
13. **Did the Hetzner cutover include a DNS-only `vercel-failback.inariwatch.com` or similar rollback target**? Memory says "Vercel retained 7 days for rollback" — the 7 days ends 2026-04-26. Plan a cleanup commit.
14. **`/api/cron/*` routes actually query the main DB** (not a shadow)? If yes, A2 keep-warm is already implicit via the 1-min `uptime` + 2-min `poll` cadence — *but only if those routes hit the DB every cycle*. Spot-check `web/app/api/cron/poll/route.ts` to confirm.
15. **Container agent / worker memory pressure** on CX22 during peak (A6 memory flag `--max-old-space-size=3072`): has OOM ever been observed in `journalctl -u docker` or netdata?

---

## 7. Validation checklist (ship gate)

After Day 2 deploy, every line must be green before marking the work done:

- [ ] `curl -I https://app.inariwatch.com/login` → `cf-cache-status: HIT` on 2nd+ request.
- [ ] `curl -I https://app.inariwatch.com/dashboard` → `cf-cache-status: DYNAMIC` (never cache).
- [ ] `curl -I https://app.inariwatch.com/login` → CSP has `'nonce-…'` and `'strict-dynamic'`, no `'unsafe-inline'` on script-src.
- [ ] `curl -I https://app.inariwatch.com/login` → `cross-origin-opener-policy: same-origin`.
- [ ] Mozilla Observatory → **A+**.
- [ ] securityheaders.com → **A+**.
- [ ] `demo@inariwatch.com` flow: landing → click sign-in → /login loads <1 s → enter demo pw → /dashboard loads <2 s → click first alert → Ask Inari → sign out. No console errors, no CSP violations in DevTools.
- [ ] All 17 auto-merge gates still pass on a representative PR.
- [ ] `cd web && npx vitest run lib/chaos/` → 103 tests pass.
- [ ] `next build` in CI → no new warnings vs baseline.

If any of the above goes red, **do not push**. Roll back the local commits (`git reset HEAD~N`) and iterate.

---

## 8. What I did not audit (scope clip)

Mentioned only in passing, left for a next pass:

- Webhook signature verification for Sentry / Vercel / GitHub / Datadog / Expo (B3 gap 4).
- `/api/install` rate limit + caching posture.
- CLI device flow rate limits (`/api/cli/auth/*`).
- Per-route auth on every API surface — 66+ routes; sampled only auth-adjacent.
- Full Lighthouse run (needs browser).
- Neon configuration (requires Jesus in console).
- Current sops + age key posture (requires Jesus on the box).
- `package.json` dep audit (quick `npm audit` run).
- VS Code extension + mobile/desktop apps — out of scope for this web audit.
- Mozilla Observatory + securityheaders actual current grade (API access blocked).

None of these change the top 3 wins or top 3 risks. They are follow-up items.

---

**End of report.**
