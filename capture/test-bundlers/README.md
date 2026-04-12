# Bundler compatibility test suite

Validates that `@inariwatch/capture` builds cleanly across every major bundler.
Required reading before publishing a new capture release.

## What it catches

- `Module not found: Can't resolve 'crypto'` (the March 2026 incident)
- `UnhandledSchemeError: node:` scheme rejections
- Package exports misconfig
- Tree shaking breakage
- Any warning/error on build or runtime

## Running

```bash
cd capture
npm run build       # rebuild dist first
cd test-bundlers
node run-all.mjs
```

First run installs ~700MB of bundler deps (one-time). Subsequent runs are ~1 min.

## Layout

Each sub-app imports capture via `file:../..` workspace link, so every run tests
the **current** state of `capture/dist/`. No publishing needed.

| App              | Bundler             | Covers                                      |
|------------------|---------------------|---------------------------------------------|
| `node-esm/`      | none (runtime only) | `node --import @inariwatch/capture/auto`    |
| `esbuild-app/`   | esbuild             | CLI bundling, Bun, serverless builds        |
| `webpack-app/`   | webpack 5           | CRA, Vue CLI, Angular, raw webpack          |
| `vite-app/`      | Vite + Rollup       | Vite, Nuxt, Remix, SvelteKit, Astro, Qwik   |
| `rollup-app/`    | Rollup              | Library builds, Rollup-pure pipelines       |
| `next-app/`      | Next.js (both)      | Next webpack build + Next Turbopack build   |

## Adding a new bundler

1. Create `test-bundlers/<bundler>-app/` with a `package.json` that includes
   `"@inariwatch/capture": "file:../.."`.
2. Add a `build` script and a minimal `src/entry.js` that imports + uses capture.
3. Add the app to the `apps` array in `run-all.mjs`.
