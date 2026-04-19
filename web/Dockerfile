# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage Dockerfile for InariWatch web (Next.js 15, standalone output).
#
# Stages:
#   base    — Debian slim with the OS libs Node + sharp + openssl need
#   deps    — npm ci for production install (no dev deps)
#   build   — full install + next build (emits .next/standalone + .next/static)
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
#   - Build args for ownership on COPY so the non-root user can read everything
#     without an extra chown pass.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      openssl \
      libc6 \
  && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# ─── deps ────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --include=prod --include=optional

# ─── build ───────────────────────────────────────────────────────────────────
FROM base AS build
COPY package.json package-lock.json ./
# Use --include=dev to get tsx, drizzle-kit, typescript — required by next build.
RUN npm ci
COPY . .
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
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user. UID 1001 matches Vercel's convention and most Node
# container patterns so bind-mounted volumes behave predictably.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home /app --shell /sbin/nologin nextjs

# Standalone output + static assets + public/
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Sharp: must come from `deps` (prod install). The trace in `standalone` drops
# optional native modules; copying the whole sharp dir keeps every platform
# variant that npm resolved and next/image tries to dlopen at first request.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/sharp ./node_modules/sharp

# Build-time version tag surfaced at /api/health. Populated from CI.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

USER nextjs
EXPOSE 3000

# Kamal's healthcheck hits /api/health. server.js is the standalone entrypoint
# that Next.js emits under .next/standalone/server.js.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
