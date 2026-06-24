# Integrations catalog — archived

The `/integrations` dashboard page was removed on 2026-05-06 after the
2026-05-05 *sole-integration cut* left it with one card (Capture SDK).

- **Capture** moved to `/projects/<slug>` next to the connected GitHub repo
  (`web/app/(dashboard)/projects/[slug]/connected-capture.tsx`).
- **Third-party catalog entries** below are preserved here so reviving any
  of them is a single PR.

## Reviving an integration

The catalog UI is dead, but the runtime gates that disable each service
still live in three places. Flipping the catalog entry is **not enough** —
you must also flip the matching `SUB_ROUTES` entry in `app/api/cron/poll/route.ts`
and the `DISABLED` const in the corresponding webhook route under
`app/api/webhooks/<service>/[integrationId]/route.ts`.

Then rebuild the dashboard surface (a per-project section like
`connected-capture.tsx`, or a dedicated /integrations page if the count
makes a catalog worth it again).

## Archived catalog entries

```ts
// service, label, desc, mode, optional cli cmd
{ service: "agent",            label: "InariWatch Agent",  desc: "Kernel-level observability — process, network, filesystem, DNS, TLS, syscall, security",        mode: "web" },
{ service: "github",           label: "GitHub",            desc: "Stale PRs, failed CI runs, unreviewed pull requests",                                          mode: "web" },
{ service: "vercel",           label: "Vercel",            desc: "Failed deployments, build errors, preview failures",                                            mode: "web" },
{ service: "netlify",          label: "Netlify",           desc: "Failed deploys, build errors, auto-rollback on production incidents",                           mode: "web" },
{ service: "cloudflare-pages", label: "Cloudflare Pages",  desc: "Deployment failures, stage errors, production rollback",                                       mode: "web" },
{ service: "render",           label: "Render",            desc: "Build failures, deploy errors, rollback to last live deploy",                                  mode: "web" },
{ service: "sentry",           label: "Sentry",            desc: "New errors, frequency spikes, affected users",                                                  mode: "web" },
{ service: "uptime",           label: "Uptime Monitor",    desc: "HTTP endpoint health checks, response time monitoring",                                         mode: "web" },
{ service: "git",              label: "Git local",         desc: "Unpushed commits, stale branches — runs on your machine",                                       mode: "cli", cmd: "inari add git" },
{ service: "postgres",         label: "PostgreSQL",        desc: "Slow queries, connection spikes, table growth",                                                 mode: "web" },
{ service: "npm",              label: "npm / Cargo",       desc: "CVE alerts on your dependencies",                                                               mode: "web" },
{ service: "datadog",          label: "Datadog",           desc: "Monitor alerts, log anomalies, infrastructure spikes",                                          mode: "web" },
{ service: "expo",             label: "Expo",              desc: "EAS Build failures, OTA update rollbacks, app crashes",                                         mode: "web" },
```

The full deleted page (catalog + connect modal + supporting components)
is recoverable via `git log -- web/app/\(dashboard\)/integrations/`.
