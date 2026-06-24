# Bundle-shape validation app — Next.js 15

This is a minimal Next.js 15 (Turbopack) app whose only purpose is to
exercise `@inariwatch/capture` through the **real** Next bundler, then
assert via `scripts/verify-bundle.mjs` that the heavy-but-optional
modules (redact, intent, causal) are NOT in the produced bundle when
the SDK is imported in the default configuration.

The standalone esbuild tests in `capture/test/lazy-*.test.mjs` cover
the same invariant against esbuild's bundler. This app covers
Turbopack / Webpack / Next.js' actual production-build path. They
catch different regression classes — e.g., a Turbopack-specific
import-resolution change wouldn't show up in esbuild tests.

## Layout

```
test-bundlers/next15/
├── app/
│   ├── layout.tsx           # required by Next 15 App Router
│   └── page.tsx             # imports captureMessage (touched, not called)
├── instrumentation.ts       # mirrors the docs' install snippet
├── next.config.ts           # withInariWatch wrapper
├── tsconfig.json
├── package.json             # capture as `file:../..` workspace dep
└── scripts/
    └── verify-bundle.mjs    # post-build scanner — exits 1 if leaks
```

## Usage

```bash
# From this directory:
npm install
npm run build
npm run verify
```

The CI workflow at `.github/workflows/bundle-size.yml` runs the same
three commands as a job. Failure = a PR has leaked a heavy module
into the initial bundle.

## Marker strings

`verify-bundle.mjs` scans `.next/**/*.js` for known identifiers that
only appear in the heavy modules:

| Module | Markers |
|---|---|
| `redact` | `DEFAULT_PATTERNS`, `SENSITIVE_KEYS`, `REDACTED_EMAIL` |
| `intent` | `zodSource`, `typescriptSource`, `prismaSource`, ... |
| `causal` | `installPgHook`, `installAllHooks`, `extractSubgraph` |

If a future refactor renames any of these, update the marker list
in `verify-bundle.mjs` AND in `capture/test/lazy-redact.test.mjs` /
`lazy-intent.test.mjs` so both layers stay in sync.

## Why a separate package, not part of the main test suite

`@inariwatch/capture` is published with zero dependencies (only
optional peers `rrweb` and `web-vitals`). Adding Next.js as a test
dep would inflate the published install. Keeping the bundler harness
in `test-bundlers/` (not exported by package.json) keeps the
publishable surface clean while still giving CI a real
production-bundler validation.
