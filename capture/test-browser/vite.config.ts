import { defineConfig } from "vite"
import { resolve } from "path"

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      // Resolve the browser subpath directly from source
      "@inariwatch/capture/browser": resolve(__dirname, "../src/browser.ts"),
      "@inariwatch/capture": resolve(__dirname, "../src/index.ts"),
      // Map /src/awake/* to the actual location so the trigger imports in
      // index.html resolve. Without this alias, Vite's import analyzer
      // can't reach ../src from test-browser/ (its root) and returns 500
      // for the whole script chunk — `@vite-ignore` doesn't help on
      // inline <script type="module"> blocks.
      "/src/awake": resolve(__dirname, "../src/awake"),
    },
  },
  optimizeDeps: {
    // web-vitals lives in capture/node_modules — include so Vite pre-bundles it
    include: ["web-vitals", "web-vitals/attribution"],
  },
  server: {
    port: 5199,
    open: true,
    fs: {
      // Allow Vite to serve files from the parent dir (../src/*)
      allow: [resolve(__dirname, "..")],
    },
  },
})
