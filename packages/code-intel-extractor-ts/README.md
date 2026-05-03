# @inariwatch/code-intel-extractor-ts

**Phase 1.2 of Code Intelligence v2** — see `CODE_INTELLIGENCE_V2_HANDOFF.md` for context.

Reads a TypeScript repo via `ts.LanguageService` and emits the four record
shapes that migration 0079 stores:

- `CodeSymbol` — declarations (functions, classes, methods, types, exported vars)
- `CodeReference` — use-sites (calls, imports, type refs, extends, implements, JSX)
- `CodeTypeFact` — structured type info per symbol (params, return, generics, throws, side effects)
- `CodeImport` — file→file import edges with resolved paths

Output is JSON to stdout by default (deterministic, testable, no DB dep).
The Phase 1.3 indexer pipeline reads stdout and writes to Postgres.

## Usage

```bash
# Build (or use vitest for development)
npm run typecheck

# Extract a repo, emit JSON to stdout
node ./src/cli.ts --repo-path /tmp/some-clone --repo-id <uuid>

# Incremental — only re-extract changed files
node ./src/cli.ts --repo-path /tmp/some-clone --repo-id <uuid> \
  --changed-files src/auth/login.ts src/auth/middleware.ts
```

## FQN format (locked in Phase 1.1)

```
<file_path>::<owner_chain>
```

Examples:

- `src/auth/login.ts::validateUser`
- `src/auth/login.ts::AuthService.login`
- `src/auth/login.ts::AuthService.validate`  (sibling method)
- `packages/sdk/src/index.ts::SDK.Inner.Helper`

The extractor MUST NOT suffix FQNs to disambiguate declaration merging. The
schema's `UNIQUE (repo_id, fqn, kind)` constraint encodes the merging — interface
+ namespace + value sharing the same FQN each become one row, distinguished by
`kind`. Queries by FQN naturally return the merged set.

## Granularity

Top-level + class members only. Local variables, function parameters, and
block-scoped declarations are NOT emitted. Reduces table size by ~10× on real
repos and keeps queries fast.

## Tests

```bash
npm test
```

20 hand-crafted fixtures cover the surface the extractor must support:

- simple function / variable / class
- methods (static, abstract, async, private/protected/public)
- interfaces, type aliases, enums, namespaces
- generics, decorators, JSX components
- declaration merging (interface + namespace, interface + class)
- imports (named, default, namespace, type-only, aliased)
- conditional / mapped / template-literal types
- path aliases (when tsconfig declares them)

The 3 medium open-source repos called out in the handoff
(Excalidraw / Linear / Next.js examples) are validated as part of Phase 1.3
once the indexer pipeline can drive end-to-end runs against cloned repos.

## Hard rules

- Reuse the TypeScript compiler. Never reinvent type resolution. Always go
  through `program.getTypeChecker()`.
- Skip `node_modules` for symbol extraction (still resolve types from there
  for signatures).
- Memory budget 4 GB. If a repo would exceed, fall back to per-file
  extraction (slower but bounded). Phase 1.3 owns this fallback path.
- No AI calls. The extractor is purely structural. Any AI features that
  need to consume extractor output go through `@inariwatch/ai-router`
  per `INARI_AI_ARCHITECTURE.md` §6.
