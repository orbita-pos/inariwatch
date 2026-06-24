# Preview Fix — operator runbook

Internal reference for operating Preview Fix. Covers rollout flags, infra
dependencies, cost envelope, and troubleshooting paths that assume SSH access
to Hetzner and a psql to Neon. Not customer-facing — the public docs at
`/docs#preview-fix` only cover what a SaaS user can act on.

## 1. Rollout flag

Two env vars gate access at the request level. Either match is enough.

| Value                   | Behavior                                                  |
| ----------------------- | --------------------------------------------------------- |
| `*`                     | Everyone with a merged remediation sees the panel.        |
| `<uuid>,<uuid>`         | Comma-separated allowlist of org or user UUIDs.           |
| _(unset or empty)_      | Panel hidden; `POST /api/alerts/:id/preview` returns 403. |

```bash
# Global on — ship to all users.
PREVIEW_FIX_ORGS=*

# Curated alpha — only the listed orgs / users see the panel.
PREVIEW_FIX_ORGS=f4b0ed46-aab2-4d2b-aa0d-e8c0ae37f5f7,...
PREVIEW_FIX_USERS=c70684ce-871b-497e-90de-6135249fb495,...

# Kill switch — independent of the flags above. When "1",
# POST /api/alerts/:id/preview returns 503 with a friendly error.
# Existing previews still render from DB; new kickoffs are blocked.
PREVIEW_FIX_KILL=1
```

Flag evaluation lives in `web/lib/feature-flags.ts::isPreviewFixEnabled`.

Finding a user / org UUID:

```sql
SELECT u.id AS user_id, u.active_org_id AS org_id, o.name
FROM users u
LEFT JOIN organizations o ON o.id = u.active_org_id
WHERE u.email = 'you@example.com';
```

## 2. Infrastructure prerequisites

Preview Fix is fully deployed on our Hetzner CX22 box. Nothing on Vercel serverless.

| Component                   | Env vars                                                                          | Purpose                                                                       |
| --------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Go staging server           | `STAGING_SERVER_URL`, `STAGING_API_SECRET`                                        | Builds + runs the fix branch in an ephemeral Docker container, 24h TTL.       |
| Node worker (Playwright)    | `WORKER_URL` (same host as `STAGING_SERVER_URL`; Caddy routes `/worker/*` → 9401) | Captures the hero screenshot via headless Chromium.                           |
| Cloudflare R2               | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`          | Permanent CDN-served storage for screenshots. Reuses the Replay v2 bucket.    |
| Neon Postgres               | `DATABASE_URL`                                                                    | `preview_sessions`, `preview_predictions`, screenshot metadata.               |

Hetzner services (systemd):

- `inari-staging` — Go server, `/opt/inari-staging`, binds 9400. Config in
  `/opt/inari-staging/.env` (`DEFAULT_TTL`, `MAX_TTL`, etc.). **`MAX_TTL=86400`
  required** for Preview Fix; anything shorter caps previews below 24h.
- `inari-worker` — Node worker running `tsx src/server.ts`, `/opt/inari-worker`,
  binds 9401. Needs Playwright + Chromium installed (`npx playwright install
  chromium --with-deps`).

Caddy (`/opt/inari-staging/Caddyfile`) — the `api.staging.inariwatch.com`
block **must** route `/worker/*` to port 9401 explicitly; otherwise worker
requests fall through to the Go server (9400) and get 401s:

```
api.staging.inariwatch.com {
    handle /worker/* {
        reverse_proxy localhost:9401
    }
    handle {
        reverse_proxy localhost:9400
    }
}
```

Validate + reload: `caddy reload --config /opt/inari-staging/Caddyfile`. The
`caddy validate` command errors without `CF_API_TOKEN` in the shell — the
running Caddy has it, so reload works even when validate doesn't.

## 3. Cost envelope

At 1,000 previews / month:

- **AI (Tier 3)**: GPT-5.4 at ~$0.04 per cache miss, ~70% miss rate → **~$40/mo**
- **Hetzner containers**: ~$0.06 / preview × 1,000 → **~$60/mo** (this is
  overlap with the CX22 fixed cost, so it's not marginal)
- **R2 egress**: **~$0** — egress is free under the CX22/R2 pairing
- **Marginal per preview**: ~$0.10

The kill switch (`PREVIEW_FIX_KILL=1`) exists for the case where AI spend
or Hetzner load spikes unexpectedly.

## 4. Operator troubleshooting

### Live build failed — "Staging server not configured"

`STAGING_SERVER_URL` or `STAGING_API_SECRET` missing in the web env.

- Local dev: add to `.env.local`, restart `npm run dev`.
- Production: add on Vercel project env, redeploy.

### Stuck on "Capturing screenshot…"

Three candidates — check in order:

1. `WORKER_URL` missing in web env. Same value as `STAGING_SERVER_URL`.
2. Caddy doesn't route `/worker/*`. See §2 for the required block.
3. Worker process died. `systemctl status inari-worker` on Hetzner.

Verify the worker is reachable with:

```bash
curl -sS https://api.staging.inariwatch.com/worker/health
# → {"ok":true}
```

### Container stuck on "starting", never "running"

The app inside the container is crashing at boot (usually missing env).

```bash
# On Hetzner
docker ps -a --filter label=inari.staging.id
docker logs <name>
```

Most common root causes and how they surface in the container logs:

- `neon(process.env.DATABASE_URL!)` crashes with "No database connection
  string" → the user's `staging_env` lacks `DATABASE_URL`. Not our problem;
  they need to add it on their project settings page.
- `next start` starts, home page throws `relation "X" does not exist` →
  the DB URL is valid but the schema isn't present. Preview env should point
  at a DB with the same schema (Neon branch works well).
- Port mismatch — the Dockerfile we auto-generate binds `PORT=3000` and
  Caddy expects the same. If the user brought a custom Dockerfile that
  listens elsewhere, the health check fails.

Destroy is called after the 120s health timeout, so containers are gone
quickly. To catch them live, run this in a tmux pane before triggering:

```bash
while :; do
  cid=$(docker ps --filter label=inari.staging.id --format '{{.Names}}' | head -1)
  if [ -n "$cid" ]; then
    echo "=== $cid ==="
    docker logs -f "$cid" 2>&1
    break
  fi
  sleep 1
done
```

### Screenshot fails with `net::ERR_SSL_PROTOCOL_ERROR`

The ACME cert for the new preview subdomain hasn't issued yet. The worker
retries up to 4 times with 3s × attempt backoff — ~18s total budget. If
it persists past that, check:

- Caddy has `acme_dns cloudflare {env.CF_API_TOKEN}` in the global block.
- `CF_API_TOKEN` is non-empty in Caddy's systemd env.
- Cloudflare zone API token is still valid.

### Cert issuance unreachable / consistently slow

The acme_dns challenge flow needs outbound HTTPS to Cloudflare + DNS write
permission on the zone. Validate with:

```bash
# Manual cert probe (on Hetzner)
caddy list-certificates
# Should include preview-<id>.staging.inariwatch.com for recent deploys.
```

### Flag is set, panel still doesn't appear

Verify the user's UUID lives under the flagged org. The panel gate is
`isPreviewFixEnabled({ organizationId, userId })` with `organizationId`
pulled from `alert.projectId → projects.organization_id`. If the project
belongs to a personal workspace, `organizationId` is null — set
`PREVIEW_FIX_USERS` instead of `PREVIEW_FIX_ORGS`.

## 5. Debug scripts

Shipped in `web/scripts/`:

| Script                           | Use                                                                    |
| -------------------------------- | ---------------------------------------------------------------------- |
| `preview-status.ts <key>`        | Inspect a preview session by alertId / previewId / slug.               |
| `staging-status.ts <deployId>`   | Query the Go server's `/status/:id` directly, bypassing the web DB.    |
| `reset-preview-session.ts <id>`  | Delete the preview row for an alert so next POST creates fresh.        |
| `retarget-remediation.ts …`      | Repoint a `remediation_sessions` row at a real GitHub branch/sha.      |
| `alert-to-project.ts <alertId>`  | Show project + repo + integrations + latest remediation for an alert.  |

All are `npx tsx scripts/<name>.ts` from `web/`.

## 6. Rollout checklist (operator)

Before flipping `PREVIEW_FIX_ORGS=*`:

- [ ] Verify Vercel env has `WORKER_URL` set (same value as `STAGING_SERVER_URL`)
- [ ] Verify Vercel env has `R2_*` vars (reused from Replay v2; should be there)
- [ ] Hetzner Go server running with `MAX_TTL=86400`
- [ ] Hetzner worker running with Playwright + Chromium installed
- [ ] Caddyfile has `/worker/*` route block
- [ ] Migrations 0066 + 0067 applied to Neon
- [ ] EAP server at `eap.staging.inariwatch.com` responding (health check)
- [ ] Test preview on your own org first — expect <60s from panel POST → hero image

Rollback: set `PREVIEW_FIX_KILL=1`. Existing previews still render, but new
kickoffs return 503. Safe to leave active indefinitely.
