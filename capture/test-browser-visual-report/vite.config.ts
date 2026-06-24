import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port:           5300,
    strictPort:     true,
    host:           "127.0.0.1",
  },
  esbuild: {
    target: "es2020",
  },
  // The capture SDK has optional peer-dep causal hooks (substrate-agent,
  // drizzle-orm, pg, prisma, ioredis) imported by capture/src/causal/.
  // They're not installed in capture/'s own node_modules — the SDK uses
  // try/catch around the dynamic imports at runtime. Tell Vite's
  // dependency scanner to skip them so the dev server boots; the
  // visual-report code path never touches these modules anyway.
  optimizeDeps: {
    exclude: [
      "@inariwatch/substrate-agent",
      "drizzle-orm",
      "drizzle-orm/sqlite-core",
      "drizzle-orm/pg-core",
      "drizzle-orm/mysql-core",
      "pg",
      "@prisma/client",
      "ioredis",
      "rrweb",
      "web-vitals",
    ],
  },
  resolve: {
    // Map the optional causal-hook deps to a tiny in-tree stub so the
    // import resolves but provides nothing — the SDK's runtime checks
    // around them turn the absence into a silent no-op.
    alias: [
      { find: /^@inariwatch\/substrate-agent$/, replacement: "/dev-shim.mjs" },
      { find: /^drizzle-orm(\/.*)?$/,           replacement: "/dev-shim.mjs" },
      { find: /^pg$/,                            replacement: "/dev-shim.mjs" },
      { find: /^@prisma\/client$/,              replacement: "/dev-shim.mjs" },
      { find: /^ioredis$/,                       replacement: "/dev-shim.mjs" },
    ],
  },
});

