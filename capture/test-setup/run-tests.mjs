#!/usr/bin/env node
/**
 * Fixture-based tests for the CLI setup-inserters.
 *
 * Tests the pure string transformations that back `capture/src/cli.ts`
 * framework setup flows. Each fixture is a snippet of what real user
 * config files look like — the assertions validate that the inserter
 * either (a) correctly modifies the file, (b) leaves it alone when
 * capture is already present, or (c) reports no-insertion-point so the
 * CLI can fall back to printing manual instructions.
 *
 * Uses Node's built-in test runner — no devDeps needed.
 *
 * Run: node test-setup/run-tests.mjs  (or)  npm test  (from capture/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  insertViteConfig,
  insertNuxtConfig,
  insertAstroConfig,
  insertNextConfig,
} from "../dist/setup-inserters.js";

// ── insertViteConfig ────────────────────────────────────────────────────────

test("insertViteConfig: inserts into existing plugins array", () => {
  const input = `import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
})
`;
  const { content, status } = insertViteConfig(input);
  assert.equal(status, "inserted");
  assert.match(content, /import \{ inariwatchVite \} from "@inariwatch\/capture\/vite"/);
  assert.match(content, /plugins: \[inariwatchVite\(\), react\(\)\]/);
});

test("insertViteConfig: handles empty plugins array", () => {
  const input = `import { defineConfig } from "vite"
export default defineConfig({ plugins: [] })
`;
  const { content, status } = insertViteConfig(input);
  assert.equal(status, "inserted");
  assert.match(content, /plugins: \[inariwatchVite\(\), \]/);
});

test("insertViteConfig: handles multi-line plugins with trailing commas", () => {
  const input = `import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import vueJsx from "@vitejs/plugin-vue-jsx"

export default defineConfig({
  plugins: [
    vue(),
    vueJsx(),
  ],
})
`;
  const { content, status } = insertViteConfig(input);
  assert.equal(status, "inserted");
  assert.match(content, /plugins: \[inariwatchVite\(\),\s*\n\s*vue\(\)/);
});

test("insertViteConfig: skips if already present", () => {
  const input = `import { defineConfig } from "vite"
import { inariwatchVite } from "@inariwatch/capture/vite"
export default defineConfig({ plugins: [inariwatchVite()] })
`;
  const { content, status } = insertViteConfig(input);
  assert.equal(status, "already-present");
  assert.equal(content, input);
});

test("insertViteConfig: reports no-insertion-point when no plugins array", () => {
  const input = `import { defineConfig } from "vite"
export default defineConfig({
  server: { port: 3000 },
})
`;
  const { status } = insertViteConfig(input);
  assert.equal(status, "no-insertion-point");
});

// ── insertNuxtConfig ────────────────────────────────────────────────────────

test("insertNuxtConfig: inserts into existing modules array", () => {
  const input = `export default defineNuxtConfig({
  modules: ["@nuxt/image"],
})
`;
  const { content, status } = insertNuxtConfig(input);
  assert.equal(status, "inserted");
  assert.match(content, /modules: \["@inariwatch\/capture\/nuxt", "@nuxt\/image"\]/);
});

test("insertNuxtConfig: creates new modules array when absent", () => {
  const input = `export default defineNuxtConfig({
  ssr: true,
  devtools: { enabled: true },
})
`;
  const { content, status } = insertNuxtConfig(input);
  assert.equal(status, "new-block-inserted");
  assert.match(content, /modules: \["@inariwatch\/capture\/nuxt"\]/);
  assert.match(content, /ssr: true/); // preserves existing
});

test("insertNuxtConfig: handles empty defineNuxtConfig", () => {
  const input = `export default defineNuxtConfig({})\n`;
  const { content, status } = insertNuxtConfig(input);
  assert.equal(status, "new-block-inserted");
  assert.match(content, /modules: \["@inariwatch\/capture\/nuxt"\]/);
});

test("insertNuxtConfig: skips if already present", () => {
  const input = `export default defineNuxtConfig({
  modules: ["@inariwatch/capture/nuxt"],
})
`;
  const { content, status } = insertNuxtConfig(input);
  assert.equal(status, "already-present");
  assert.equal(content, input);
});

test("insertNuxtConfig: no-insertion-point when not using defineNuxtConfig", () => {
  const input = `module.exports = { ssr: true }\n`;
  const { status } = insertNuxtConfig(input);
  assert.equal(status, "no-insertion-point");
});

// ── insertAstroConfig ───────────────────────────────────────────────────────

test("insertAstroConfig: inserts into existing vite.plugins array", () => {
  const input = `import { defineConfig } from "astro/config"

export default defineConfig({
  vite: {
    plugins: [somePlugin()],
  },
})
`;
  const { content, status } = insertAstroConfig(input);
  assert.equal(status, "inserted");
  assert.match(content, /import \{ inariwatchVite \} from "@inariwatch\/capture\/vite"/);
  assert.match(content, /plugins: \[inariwatchVite\(\), somePlugin\(\)\]/);
});

test("insertAstroConfig: creates plugins inside vite block when plugins absent", () => {
  const input = `import { defineConfig } from "astro/config"

export default defineConfig({
  vite: {
    server: { port: 4321 },
  },
})
`;
  const { content, status } = insertAstroConfig(input);
  assert.equal(status, "new-block-inserted");
  assert.match(content, /vite: \{\s*\n\s*plugins: \[inariwatchVite\(\)\]/);
});

test("insertAstroConfig: skips if already present", () => {
  const input = `export default defineConfig({
  vite: { plugins: [inariwatchVite()] },
})
import { inariwatchVite } from "@inariwatch/capture/vite"
`;
  const { status } = insertAstroConfig(input);
  assert.equal(status, "already-present");
});

test("insertAstroConfig: no-insertion-point when no vite block", () => {
  const input = `import { defineConfig } from "astro/config"

export default defineConfig({
  integrations: [],
})
`;
  const { status } = insertAstroConfig(input);
  assert.equal(status, "no-insertion-point");
});

// ── insertNextConfig ────────────────────────────────────────────────────────

test("insertNextConfig: wraps ESM default export identifier", () => {
  const input = `/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true }
export default nextConfig
`;
  const { content, status } = insertNextConfig(input);
  assert.equal(status, "inserted");
  assert.match(content, /import \{ withInariWatch \} from "@inariwatch\/capture\/next"/);
  assert.match(content, /export default withInariWatch\(nextConfig\)/);
});

test("insertNextConfig: handles CJS module.exports with identifier", () => {
  const input = `const nextConfig = { reactStrictMode: true }
module.exports = nextConfig
`;
  const { content, status } = insertNextConfig(input);
  assert.equal(status, "inserted");
  assert.match(content, /const \{ withInariWatch \} = require\("@inariwatch\/capture\/next"\)/);
  assert.match(content, /module\.exports = withInariWatch\(_nextConfig\);/);
});

test("insertNextConfig: handles CJS with inline object", () => {
  const input = `module.exports = { reactStrictMode: true }\n`;
  const { content, status } = insertNextConfig(input);
  assert.equal(status, "inserted");
  assert.match(content, /const _nextConfig = \{ reactStrictMode: true \}/);
  assert.match(content, /module\.exports = withInariWatch\(_nextConfig\)/);
});

test("insertNextConfig: skips if already present", () => {
  const input = `import { withInariWatch } from "@inariwatch/capture/next"
const nextConfig = {}
export default withInariWatch(nextConfig)
`;
  const { status } = insertNextConfig(input);
  assert.equal(status, "already-present");
});

test("insertNextConfig: no-insertion-point when no default export and no module.exports", () => {
  const input = `const nextConfig = {}\n// someone forgot to export\n`;
  const { status } = insertNextConfig(input);
  assert.equal(status, "no-insertion-point");
});
