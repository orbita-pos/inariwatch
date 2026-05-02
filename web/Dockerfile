# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage Dockerfile for InariWatch web (Next.js 15, standalone output).
#
# Build context = repo ROOT (set via `builder.context: ..` in
# web/config/deploy.yml). The web app pulls in the workspace-internal package
# `packages/ai-router/` through a TypeScript path alias in web/tsconfig.json
# ("@inariwatch/ai-router" → "../packages/ai-router/src/index.ts"), so the
# build needs both web/ and packages/ai-router/ inside the image.
#
# All COPY source paths below are therefore prefixed with `web/` or
# `packages/ai-router/` — they resolve relative to the repo root, not to web/.
#
# Stages:
#   base    — Debian slim with the OS libs Node + sharp + openssl need
#   deps    — npm ci for production install (no dev deps)
#   build   — full install + COPY web + COPY packages/ai-router + next build
#   runtime — minimal final image, non-root user, only the files next start needs
#
# Design choices:
#   - Debian bookworm-slim (not Alpine). Alpine's musl libc breaks sharp and
#     a handful of other native Node deps; the ~20MB size penalty is worth it.
#   - Non-root `nextjs` user. The app handles untrusted webhook payloads and
#     runs AI-generated shell-ish code paths — root inside the container is
#     a real attack surface.
#   - Sharp binary copied explicitly. Next.js 15 bundles sharp for next/image,
#     but standalone's tracer drops it; without this copy, image optimization
#     silently falls back to a 10x-slower WASM path. See
#     nextjs.org/docs/messages/sharp-missing-in-production.
#   - `outputFileTracingRoot` in next.config.ts is set to the monorepo root,
#     so the standalone entrypoint lives at .next/standalone/web/server.js
#     and the runtime CMD is `node web/server.js` (not `node server.js`).
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      openssl \
      libc6 \
  && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo

# ─── deps ────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY web/package.json web/package-lock.json ./web/
WORKDIR /repo/web
RUN npm ci --include=prod --include=optional

# ─── build ───────────────────────────────────────────────────────────────────
FROM base AS build
COPY web/package.json web/package-lock.json ./web/
WORKDIR /repo/web
# Use --include=dev to get tsx, drizzle-kit, typescript — required by next build.
RUN npm ci
WORKDIR /repo
COPY web/ ./web/
COPY packages/ai-router/ ./packages/ai-router/
WORKDIR /repo/web
ENV NODE_ENV=production
# Next build needs these public env vars baked in at build time. Set them via
# Kamal's `env.clear` so the build args come from the registry-signing CI.
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY=${NEXT_PUBLIC_VAPID_PUBLIC_KEY}
# Dummy DATABASE_URL just to satisfy the eager `neon()` init at module load
# in `lib/db/index.ts`. `neon()` only parses the URL at construction — it
# does not connect. The real value comes from Kamal's `env.secret` at
# runtime and overrides this. Without this ENV, `next build`'s
# "Collecting page data" step throws "No database connection string".
ENV DATABASE_URL="postgres://buildtime:buildtime@localhost:5432/buildtime"
RUN npm run build

# ─── runtime ────────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user. UID 1001 matches Vercel's convention and most Node
# container patterns so bind-mounted volumes behave predictably.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home /app --shell /sbin/nologin nextjs

# With outputFileTracingRoot=<repo root>, Next.js writes the standalone
# bundle rooted at the monorepo, so paths inside .next/standalone mirror
# the repo layout: server.js lands at .next/standalone/web/server.js, the
# traced node_modules at .next/standalone/web/node_modules/, etc.
COPY --from=build --chown=nextjs:nodejs /repo/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/web/.next/static ./web/.next/static
COPY --from=build --chown=nextjs:nodejs /repo/web/public ./web/public

# Sharp: must come from `deps` (prod install). The trace in `standalone` drops
# optional native modules; copying the whole sharp dir keeps every platform
# variant that npm resolved and next/image tries to dlopen at first request.
COPY --from=deps --chown=nextjs:nodejs /repo/web/node_modules/sharp ./web/node_modules/sharp

# Build-time version tag surfaced at /api/health. Populated from CI.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

USER nextjs
EXPOSE 3000

# Kamal's healthcheck hits /api/health. server.js is the standalone entrypoint
# emitted under .next/standalone/web/server.js when outputFileTracingRoot
# is set to the monorepo root.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "web/server.js"]
