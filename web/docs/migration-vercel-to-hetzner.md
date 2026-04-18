# Vercel → Hetzner migration runbook

Plan detallado para sacar `app.inariwatch.com` de Vercel y ponerlo en un Hetzner CX32 con Kamal 2 + Cloudflare. Economics: $30-50/mo → ~$11/mo flat, para siempre.

**Tiempo estimado:** 1-2 días de trabajo focalizado, dividido en 7 fases. Ninguna fase es destructiva hasta la Fase 6 (cutover DNS), así que podés pausar entre fases y volver.

**Criterios de éxito:**
- `app.inariwatch.com` apunta a Hetzner
- Deploy via `git push` a main toma <3min end-to-end
- Zero downtime en cutover
- Costo total infra post-migración ≤ $15/mo

**Rollback:** en cualquier punto hasta Fase 6 inclusive, flip DNS de vuelta a Vercel (TTL 5min). Código del repo sigue funcionando en Vercel durante toda la migración — no estamos quemando barcos.

---

## Pre-work (30-60 min)

- [ ] **Decisión server:** upgrade CX22 existente → CX32 (8GB RAM) en Hetzner dashboard (1 click, sin migración), o provisionar CX32 separado para el web (el existente sigue con staging + worker + EAP). **Recomendación:** separar. Web en `inari-web` (nuevo CX32 €8/mo), ops en `inari-staging` (CX22 existente €5/mo). Total €13/mo, aislamiento correcto.
- [ ] Crear nuevo CX32 "inari-web" en Hetzner dashboard, Ubuntu 24.04, agregar tu SSH public key.
- [ ] Anotar IP pública.
- [ ] Agregar entrada en `~/.ssh/config`:
```
Host inari-web
  HostName <IP>
  User root
```
- [ ] **GitHub Container Registry (GHCR):** verificar acceso con un personal access token que tenga `write:packages`. Crear uno si no lo tenés: github.com/settings/tokens (classic, scope `write:packages`).
- [ ] **Cloudflare:** cuenta ya activa (para R2). Verificar que `inariwatch.com` esté en Cloudflare (nameservers apuntando a Cloudflare). Si no, migrar el dominio al registrar o cambiar nameservers.
- [ ] **Age keypair** para secrets:
```bash
# En tu máquina local
age-keygen -o ~/.config/sops/age/keys.txt
# La public key es la que va al repo (.sops.yaml)
# La private key va al server vía scp
```

---

## Fase 1 — Code changes (4-6h)

Todo el código sigue desplegable a Vercel mientras hacés estos cambios. Son drop-in compatible.

### 1.1 Edge → Node runtime (5 min)

```tsx
// web/app/opengraph-image.tsx
- export const runtime = "edge";
+ export const runtime = "nodejs";
```

Validar: `next build` sigue pasando. OG image sigue renderizando en dev.

### 1.2 Borrar `maxDuration` exports (5 min)

5 archivos. Son hints de Vercel que no tienen efecto self-hosted:

```
web/app/api/cron/whatif-retention/route.ts
web/app/api/cron/replay-retention/route.ts
web/app/api/cron/cleanup-ai-logs/route.ts
web/app/api/replay/[sessionId]/analyze/route.ts
web/app/api/replay/classify-pii/route.ts
```

Buscar `export const maxDuration =` y borrar la línea.

### 1.3 Remover `VERCEL_ENV` check en robots.ts (5 min)

```tsx
// web/app/robots.ts
- const isPreview = process.env.VERCEL_ENV === "preview";
+ const isPreview = process.env.DISABLE_INDEXING === "1";
```

En el server de Hetzner, no setear `DISABLE_INDEXING`. Staging server (si lo usamos): `DISABLE_INDEXING=1`.

### 1.4 Asegurar `APP_URL` siempre seteado (2 min)

Verificar que `APP_URL=https://app.inariwatch.com` esté en los env vars del nuevo server (Paso 2.5). El código ya tiene fallback chain `APP_URL ?? VERCEL_URL ?? hardcoded`, pero queremos que `APP_URL` sea la primary siempre.

### 1.5 Reemplazar `waitUntil()` con BullMQ (2-4h, el único lift real)

Archivos afectados:
- `web/app/api/slack/interactions/route.ts` (4 calls)
- `web/app/api/slack/events/route.ts` (1 call)
- `web/app/api/slack/commands/route.ts` (3 calls)

BullMQ ya corre en el worker Hetzner. Crear una cola dedicada para "slack-background":

```typescript
// web/lib/queue/slack-background.ts (nuevo)
import { Queue } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

export const slackBackgroundQueue = new Queue("slack-background", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 86400 },
  },
});
```

Reemplazo patrón:

```typescript
// Antes
import { waitUntil } from "@vercel/functions";
waitUntil(runSlackRemediation(params));

// Después
import { slackBackgroundQueue } from "@/lib/queue/slack-background";
await slackBackgroundQueue.add("slack-remediation", params);
```

Worker handler (en `worker/src/workers/`):

```typescript
// worker/src/workers/slack-background.worker.ts (nuevo)
import { Worker } from "bullmq";
import { connection } from "../queues";

export function startSlackBackgroundWorker() {
  return new Worker(
    "slack-background",
    async (job) => {
      switch (job.name) {
        case "slack-remediation":
          // Call the same fn that ran in waitUntil before
          break;
        case "slack-postmortem":
          break;
        // ...
      }
    },
    { connection, concurrency: 3 },
  );
}
```

Registrar en `worker/src/server.ts` junto a los workers existentes.

**Gotcha:** el handler que antes corría en Vercel serverless tiene que ser IDEMPOTENTE ahora (BullMQ puede reintentar 3x). Revisar que no duplique PRs, mensajes, etc. Usar el job.id como dedup key.

### 1.6 Remover SSE 55s safety-nets (opcional, 30 min)

En 6 endpoints hay comentarios "Auto-close under Vercel's 60s serverless limit". Esos auto-close pueden quedarse (defensive) o borrarse (cleaner). Dejarlos por ahora — hacen no harm, evitan runaway connections.

### 1.7 `next.config.ts` — standalone output (2 min)

```typescript
// web/next.config.ts
const nextConfig: NextConfig = {
  output: "standalone", // <- add this
  // ...existing config
};
```

Valida que `next build` genera `.next/standalone/` + `.next/static/`.

### 1.8 `/api/health` route (5 min)

Si no existe, crear:

```typescript
// web/app/api/health/route.ts
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() });
}
```

Kamal usa esto para health checks.

### 1.9 Dockerfile (10 min)

```dockerfile
# web/Dockerfile (nuevo)
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user (critical for security)
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Sharp binary — standalone mode drops it by default
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/sharp ./node_modules/sharp

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

Validar local:
```bash
docker build -t inari-web:local -f web/Dockerfile web/
docker run -p 3000:3000 --env-file web/.env.local inari-web:local
curl http://localhost:3000/api/health
```

### 1.10 Commit todo junto

```bash
git add web/app/opengraph-image.tsx web/app/api/cron/ web/app/api/replay/ \
        web/app/robots.ts web/lib/queue/ web/app/api/slack/ web/app/api/health/ \
        web/next.config.ts web/Dockerfile worker/src/workers/slack-background.worker.ts \
        worker/src/server.ts
git commit -m "feat(deploy): prepare for self-hosted migration"
```

**Checkpoint:** push a Vercel staging branch, verificar que sigue funcionando. Si sí → Fase 2.

---

## Fase 2 — Infra setup en CX32 (2-3h)

### 2.1 Bootstrap del server

```bash
# Desde tu local
ssh inari-web
```

En el server:
```bash
# Update
apt update && apt upgrade -y
apt install -y curl ca-certificates gnupg lsb-release ufw

# Docker (official)
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Age + sops
apt install -y age
ARCH=$(dpkg --print-architecture)
curl -LO "https://github.com/getsops/sops/releases/download/v3.9.0/sops-v3.9.0.linux.${ARCH}"
chmod +x "sops-v3.9.0.linux.${ARCH}"
mv "sops-v3.9.0.linux.${ARCH}" /usr/local/bin/sops

# Firewall
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

### 2.2 Age private key

Desde local:
```bash
scp ~/.config/sops/age/keys.txt inari-web:/root/.config/sops/age/keys.txt
```

En el server:
```bash
chmod 600 /root/.config/sops/age/keys.txt
```

### 2.3 GHCR login en el server

```bash
# En el server
echo "<YOUR_GHCR_PAT>" | docker login ghcr.io -u orbita-pos --password-stdin
```

Kamal usará esto para pullear la imagen.

### 2.4 Crear `.sops.yaml` y `.env.sops.yaml` en el repo

```yaml
# web/.sops.yaml
creation_rules:
  - path_regex: \.env\.sops\.ya?ml$
    encrypted_regex: "^(?!#)"
    age: <YOUR_AGE_PUBLIC_KEY>
```

Crear archivo cifrado:
```bash
cd web
cp .env.local .env.sops.yaml
# Editar .env.sops.yaml para que tenga solo los vars de PROD (no dev overrides)
sops -e -i .env.sops.yaml
```

El archivo cifrado SE COMMITEA. La private key NUNCA.

### 2.5 Env vars de producción

Mínimo que necesita el web en prod:

```
# Core
DATABASE_URL=<neon pooled>
NEXTAUTH_URL=https://app.inariwatch.com
NEXTAUTH_SECRET=<random 32 bytes>
APP_URL=https://app.inariwatch.com
CRON_SECRET=<matches Hetzner Go scheduler>

# Integrations
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...

# AI
PLATFORM_AI_KEY=<openai>
PLATFORM_ANTHROPIC_KEY=<claude>
ENCRYPTION_KEY=<existing>

# Infra
REDIS_URL=<upstash>
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=...
STAGING_SERVER_URL=https://api.staging.inariwatch.com
STAGING_API_SECRET=...
WORKER_URL=https://api.staging.inariwatch.com
EAP_SERVER_URL=https://eap.staging.inariwatch.com

# Preview Fix
PREVIEW_FIX_ORGS=*   # o tu UUID si querés alpha gradual

# Email
RESEND_API_KEY=...

# Web Push
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_EMAIL=...

# Plausible (ya está hardcodeado en layout.tsx, no env)
```

### 2.6 Kamal setup

```bash
# Local, en web/
gem install kamal
kamal init
```

Editar `web/config/deploy.yml`:

```yaml
service: inari-web
image: orbita-pos/inari-web

servers:
  web:
    - <IP de inari-web>

proxy:
  ssl: true
  host: app.inariwatch.com
  app_port: 3000
  healthcheck:
    path: /api/health
    interval: 10
    timeout: 5

registry:
  server: ghcr.io
  username: orbita-pos
  password:
    - KAMAL_REGISTRY_PASSWORD  # pulled from env

env:
  secret:
    - DATABASE_URL
    - NEXTAUTH_SECRET
    - ENCRYPTION_KEY
    # ...todos los secrets
  clear:
    NODE_ENV: production
    PORT: 3000
    NEXT_TELEMETRY_DISABLED: "1"

builder:
  arch: amd64
  cache:
    type: registry
    options: mode=max

ssh:
  user: root
  keys_only: true
  keys: [ '~/.ssh/id_ed25519' ]

accessories: {}   # Redis ya está externo (Upstash)
```

`web/.kamal/secrets`:
```bash
# Kamal lee este archivo. Los valores vienen de sops.
KAMAL_REGISTRY_PASSWORD=$(gh auth token)  # o PAT directo
DATABASE_URL=$(sops -d --extract '["DATABASE_URL"]' .env.sops.yaml)
# ... repetir por cada secret
```

Para no duplicar, usar un script helper:
```bash
# web/.kamal/secrets (generado)
#!/usr/bin/env bash
set -euo pipefail
export KAMAL_REGISTRY_PASSWORD="${GITHUB_TOKEN:-$(cat ~/.ghcr-token)}"
eval "$(sops -d .env.sops.yaml | sed 's/^/export /')"
```

Mejor: usar Kamal's native sops support (investigar docs de Kamal 2).

### 2.7 First deploy

```bash
cd web
kamal setup   # instala Kamal proxy en el server, pull image, primer run
```

Debería terminar con `healthcheck ok` y `http://<IP>:80` respondiendo a `/api/health`.

Kamal-proxy maneja Let's Encrypt automático para `app.inariwatch.com` (configurado arriba). PERO el TLS aún no funciona hasta que el DNS apunte a este server.

---

## Fase 3 — CI/CD con GitHub Actions (1-2h)

### 3.1 SSH deploy key

En el server:
```bash
# Crear un deploy key dedicado para GitHub Actions
ssh-keygen -t ed25519 -f /root/.ssh/github-deploy -N ""
cat /root/.ssh/github-deploy.pub >> /root/.ssh/authorized_keys
cat /root/.ssh/github-deploy   # copiar PRIVATE key
```

En GitHub: repo settings → Secrets → `HETZNER_DEPLOY_KEY` = la private key.

### 3.2 Workflow

```yaml
# .github/workflows/deploy-web.yml
name: Deploy Web to Hetzner

on:
  push:
    branches: [main]
    paths:
      - 'web/**'
      - '.github/workflows/deploy-web.yml'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.3'
          bundler-cache: false
      - run: gem install kamal

      - name: Set up SSH
        uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: ${{ secrets.HETZNER_DEPLOY_KEY }}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Decrypt secrets
        run: echo "${{ secrets.AGE_KEY }}" > /tmp/age-key.txt
        env:
          SOPS_AGE_KEY_FILE: /tmp/age-key.txt

      - name: Deploy
        working-directory: web
        env:
          KAMAL_REGISTRY_PASSWORD: ${{ secrets.GITHUB_TOKEN }}
          SOPS_AGE_KEY_FILE: /tmp/age-key.txt
        run: kamal deploy
```

En GitHub: repo secrets → `AGE_KEY` = contenido de `~/.config/sops/age/keys.txt` (private).

Push a `main` desde otro branch = build + deploy automático.

### 3.3 Test the pipeline

Branch + PR + merge. Verificar que el workflow corre, builda, deploya, healthcheck pasa.

---

## Fase 4 — Cloudflare (30 min)

### 4.1 DNS initial (gray cloud)

En Cloudflare DNS:
- Record existente apuntando a Vercel → no tocar todavía
- Agregar nuevo: `app-new.inariwatch.com` A record → `<IP inari-web>` → Proxy **off (gray cloud)**

Verificar:
```bash
curl -I https://app-new.inariwatch.com/api/health
# Debería responder 200, TLS emitido por Kamal-proxy / Let's Encrypt
```

### 4.2 Cache rules (Rules → Cache Rules)

Regla 1 — "Cache Next.js static forever":
- If URL Path matches `/_next/static/*` OR `/_next/image/*`
- Then: Cache eligibility = Eligible for cache, Edge TTL = 1 year, Browser TTL = 1 year

Regla 2 — "Bypass cache for API + SSE":
- If URL Path matches `/api/*` OR starts_with `/preview/` (landing) OR starts_with `/attestation/`
- Then: Cache eligibility = Bypass cache

Regla 3 — "Standard cache for pages":
- Everything else: default (respect origin headers)

### 4.3 SSL mode

Cloudflare → SSL/TLS → Overview → **Full (strict)**. NO Flexible.

### 4.4 Orange cloud

Proxy on para `app-new.inariwatch.com`. Re-test:
```bash
curl -I https://app-new.inariwatch.com/
curl -I https://app-new.inariwatch.com/_next/static/...  # should have cf-cache-status
```

---

## Fase 5 — Parallel run (48h observación)

### 5.1 Smoke test checklist en Hetzner (vía app-new.inariwatch.com)

- [ ] Landing page renderea
- [ ] `/login` → OAuth Google funciona
- [ ] Dashboard `/alerts` lista alerts
- [ ] Alert detail page carga
- [ ] Preview Fix panel aparece (si tenés flag activo)
- [ ] `/integrations` lista + disconnect toast OK
- [ ] Preview Fix screenshot capture pasa end-to-end
- [ ] SSE streams: `/api/remediation/stream/<id>` conecta y recibe eventos
- [ ] Slack webhook endpoint responde 200 en <3s (Slack timeout)
- [ ] Cron authenticated request funciona (manual `curl -H "Authorization: Bearer $CRON_SECRET"`)
- [ ] Webhook de Capture recibe y crea alert
- [ ] OG unfurl (share `/preview/<slug>` en Slack de prueba) → imagen real
- [ ] `next/og` en `/opengraph-image` renderea (node runtime)

Cualquier falla = fix + re-deploy. No avanzar a Fase 6 hasta 100% green.

### 5.2 Monitoring

- Capture SDK ya está apuntando a `app.inariwatch.com` desde tus propios apps → va seguir yendo a Vercel hasta cutover, OK
- En Hetzner: `docker logs -f inari-web` en otra tmux window
- Verificar que no hay errors repetitivos

### 5.3 Performance sanity check

```bash
# Desde tu máquina
ab -n 100 -c 10 https://app-new.inariwatch.com/
# Expect: p99 < 500ms, zero errors
```

---

## Fase 6 — Cutover (1h trabajo + 2-4h monitoring)

### 6.1 Pre-cutover

- TTL de `app.inariwatch.com` en Cloudflare a 5 minutos (default Cloudflare usa Auto ≈ 5min, confirmar)
- Comunicar ventana (si tenés cualquier customer): "deploying new infrastructure next Xmin, expect no downtime"

### 6.2 DNS flip

En Cloudflare:
- Record `app.inariwatch.com` → change target from Vercel to `<IP inari-web>`
- Orange cloud on
- (No tocar `app-new.inariwatch.com` todavía)

Propagación: 5 min. Mientras tanto:
```bash
# Verificar desde varias ubicaciones
dig app.inariwatch.com @1.1.1.1
dig app.inariwatch.com @8.8.8.8
```

### 6.3 Post-cutover smoke test

Mismo checklist de 5.1, pero contra `app.inariwatch.com`. Si algo falla:

**Rollback:** en Cloudflare DNS, revert record de vuelta a Vercel. 5 min y volvés al estado previo. Zero data loss porque el DB es el mismo Neon.

### 6.4 Monitor 2-4h

- `docker logs -f inari-web` en el server
- Dashboard InariWatch propio en otro browser, mirá si aparecen errors
- Capture SDK sigue reportando — asegurate que no hay error spike

---

## Fase 7 — Decommission Vercel (día 8)

Esperar 7 días después del cutover antes de decommission. Tiempo de rollback si sale algo raro.

Día 8:
- [ ] Vercel dashboard → project settings → borrar env vars (no el project aún)
- [ ] Remover Vercel webhook de tu integration Vercel en el dashboard de InariWatch (si aplica)
- [ ] Cambiar Vercel plan a Hobby (o cancelar Pro). Esperar billing cycle.
- [ ] Borrar `vercel.json` del repo (commit)
- [ ] Borrar `@vercel/functions` del `package.json` (ya no lo usás)
- [ ] Remover GitHub Actions workflow de Vercel si existe

Guardar el project en Vercel por ~30 días por las dudas. Después delete.

---

## Checklist final de migración

**Infrastructure:**
- [ ] CX32 `inari-web` provisioned, bootstrapped
- [ ] Age key pair, sops in place
- [ ] GHCR access configured
- [ ] Kamal first deploy successful
- [ ] Caddy / Kamal-proxy serving on 443 con Let's Encrypt
- [ ] Cloudflare DNS + cache rules + SSL full strict

**Code:**
- [ ] Edge runtime removed (opengraph-image.tsx)
- [ ] `maxDuration` exports purgados (5 archivos)
- [ ] `VERCEL_ENV` check replaced
- [ ] `@vercel/functions` replaced con BullMQ en 3 Slack routes
- [ ] `next.config.ts` standalone output
- [ ] Dockerfile con non-root + sharp
- [ ] `/api/health` route
- [ ] Worker tiene slack-background worker running

**Operations:**
- [ ] GitHub Actions workflow deploy on push to main
- [ ] Kamal logs accessible (`kamal app logs`)
- [ ] Rollback tested (`kamal app rollback`)
- [ ] Parallel run 48h passed
- [ ] Cutover DNS executed, monitored 4h
- [ ] 7 days stable post-cutover
- [ ] Vercel decommissioned

---

## Estimación de tiempo real

| Fase | Optimista | Realista | Si algo falla |
|---|---|---|---|
| Pre-work | 30min | 1h | 2h |
| 1 — Code | 4h | 6h | 10h (debugging BullMQ replacements) |
| 2 — Infra | 2h | 3h | 6h (sops quirks, Kamal first-timer) |
| 3 — CI/CD | 1h | 2h | 4h (GitHub Actions secrets ordering) |
| 4 — Cloudflare | 30min | 1h | 2h |
| 5 — Parallel | 48h wait (0 trabajo activo) | 48h | 48h + fixes |
| 6 — Cutover | 1h + 4h watch | 1h + 4h | + rollback if issues |
| 7 — Decomm | 30min | 30min | - |

**Total activo:** 1 día focalizado + 48h de observación pasiva + 7 días de safety soak.

---

## Riesgos + mitigaciones

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| BullMQ job handler no idempotente duplica PRs Slack | Media | Dedup por job.id + audit trail. Testear con mocks antes de cutover. |
| Caddy/Kamal-proxy bufferea SSE → streams cuelgan | Media | Kamal-proxy tiene soporte nativo para streaming. Verificar en smoke test. |
| Sharp binary missing en Docker → image opt degrades | Alta si olvidás el COPY | El Dockerfile de arriba lo incluye explícitamente |
| Cloudflare caches algo que no debería (auth cookies) | Baja | Cache rule bypasses `/api/*`. Verificar headers en curl. |
| DNS propagation tarda más de 5min | Baja | TTL bajo preventivo. Worst case: 10-30min, durante el cual 90% tráfico ya está en Hetzner. |
| Kamal deploy falla en CI → stuck in "deploying" | Media | `kamal app rollback` en el server manualmente. O `kamal app stop` + `kamal app start`. |

---

## Post-migration roadmap (semanas 2-8)

Una vez estable:

1. **Preview environments por PR** (1 día, semana 2-3) — segundo CX22 con wildcard `*.preview.inariwatch.com`, GitHub Action en `pull_request` → `kamal deploy --destination=pr-<N>`.

2. **ISR shared cache** (4h, semana 4) — `@neshca/cache-handler` → Upstash. Harmless hoy con 1 replica, future-proof para 2+.

3. **Grafana Cloud free tier + OpenTelemetry** (1 día, semana 4) — traces, metrics, dashboards. Tu Capture SDK ya maneja errors; esto agrega infra observability.

4. **Scale test** (half day, semana 6) — k6 load test a 500 concurrent. Si RAM >80% sustained → upgrade a CX42 (€14/mo). Si todo OK → listo.

5. **Write postmortem / blog post** (2h, semana 8) — "Why we left Vercel". Content + inbound + proof de unit economics.

---

## Un día, bien ejecutado, y olvidás el stress de Vercel para siempre.
