-- Code Intelligence v2 — Phase 1.1
--
-- Per CODE_INTELLIGENCE_V2_HANDOFF.md §1.1, this migration introduces the four
-- semantic-graph tables that v2 will populate via the TypeScript extractor
-- binary (Phase 1.2) and query through web/lib/code-intelligence-v2/queries.ts
-- (Phase 1.4). The tables coexist with the v1 statistical layer
-- (`code_chunks`, `code_dependencies`) — flag `CODE_INTEL_V2=shadow|on|off`
-- decides which layer the service-level dispatcher returns.
--
-- ── Decisions explicit in this PR ──────────────────────────────────────────
--
-- 1. **Fully-qualified-name format.** `code_symbols.fqn` is
--    `<file_path>::<owner_chain>` where `owner_chain` is the dotted path
--    from file scope to the symbol. Examples:
--        src/auth/login.ts::validateUser
--        src/auth/login.ts::AuthService.login
--        packages/sdk/src/index.ts::SDK.Inner.Helper
--    The extractor (Phase 1.2) is the canonical producer. Consumers MUST
--    treat FQNs as opaque strings; format may evolve and is documented in
--    packages/code-intel-extractor-ts/README.md.
--
-- 2. **Granularity = top-level + class members only.** Local variables,
--    function parameters, and block-scoped declarations are NOT stored as
--    symbols. Reduces table size by ~10× on real repos and keeps queries
--    fast. The extractor decides what's "top-level"; conceptually: anything
--    a remediation loop might want to navigate to.
--
-- 3. **Incremental indexing key = `ast_hash`.** The extractor SHA-256s the
--    declaration's normalized AST node and stores the hex digest. Phase 1.3
--    indexer compares hashes per (FQN, kind) and skips re-extraction when
--    unchanged. Stable across whitespace / comment edits because the hash
--    sees the AST, not the source text.
--
-- 4. **Uniqueness = `(repo_id, fqn, kind)`** — TypeScript declaration
--    merging is first-class. An interface, a namespace, and a value can share
--    the same FQN; each is one row, distinguished by `kind`. The extractor
--    MUST NOT suffix FQNs to disambiguate; callers query by FQN and get the
--    merged set naturally.
--
-- ── Coexistence invariant ──────────────────────────────────────────────────
-- v1 tables (`code_chunks`, `code_dependencies`) are NOT touched. Existing
-- consumers continue to work byte-identical. v2 lives in parallel and only
-- the service-layer dispatcher chooses between them.
--
-- ── Idempotency ────────────────────────────────────────────────────────────
-- Every CREATE TABLE / CREATE INDEX uses IF NOT EXISTS so re-running the
-- migration on an environment that has already applied it is a no-op.
-- Matches the convention from 0069/0076/0078.
--
-- ── Rollback ───────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS code_imports;
--   DROP TABLE IF EXISTS code_type_facts;
--   DROP TABLE IF EXISTS code_references;
--   DROP TABLE IF EXISTS code_symbols;

-- ── code_symbols ────────────────────────────────────────────────────────────
-- Every named entity the extractor decides is "top-level enough" to navigate.
-- One row per declaration site.
--
-- Uniqueness is `(repo_id, fqn, kind)`, NOT `(repo_id, fqn)`. TypeScript
-- supports declaration merging — an interface, a namespace, and a value
-- declaration can share the same source-level name and FQN, each contributing
-- a distinct facet (type members, namespace members, runtime value). Each
-- facet is one row; queries by FQN naturally return the merged set, which is
-- what `findReferences()` and `blastRadius()` need (callers don't care which
-- branch they hit). The extractor MUST NOT suffix FQNs to disambiguate.

CREATE TABLE IF NOT EXISTS "code_symbols" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id"       uuid NOT NULL REFERENCES "code_repositories"("id") ON DELETE CASCADE,
  "fqn"           text NOT NULL,
  "kind"          text NOT NULL,
  "name"          text NOT NULL,
  "file_path"     text NOT NULL,
  "start_line"    integer NOT NULL,
  "end_line"      integer NOT NULL,
  "start_col"     integer,
  "end_col"       integer,
  "signature"     text,
  "return_type"   text,
  "is_async"      boolean NOT NULL DEFAULT false,
  "is_exported"   boolean NOT NULL DEFAULT false,
  "is_static"     boolean NOT NULL DEFAULT false,
  "is_abstract"   boolean NOT NULL DEFAULT false,
  "visibility"    text,
  "doc_comment"   text,
  "parent_id"     uuid REFERENCES "code_symbols"("id") ON DELETE CASCADE,
  "language"      text NOT NULL,
  "ast_hash"      text NOT NULL,
  "indexed_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "code_symbols_fqn_unique" UNIQUE ("repo_id", "fqn", "kind")
);

CREATE INDEX IF NOT EXISTS "idx_code_symbols_repo_kind"
  ON "code_symbols" ("repo_id", "kind");

CREATE INDEX IF NOT EXISTS "idx_code_symbols_repo_file"
  ON "code_symbols" ("repo_id", "file_path");

CREATE INDEX IF NOT EXISTS "idx_code_symbols_name"
  ON "code_symbols" ("repo_id", "name");

COMMENT ON TABLE "code_symbols" IS
  'Code Intelligence v2 — semantic symbol catalogue. One row per declaration site (functions, classes, methods, types, exported vars). Phase 1.2 extractor populates; Phase 1.4 queries read. Coexists with v1 code_chunks behind CODE_INTEL_V2 flag.';

COMMENT ON COLUMN "code_symbols"."fqn" IS
  'Fully-qualified-name. Format: <file_path>::<owner_chain>. Treat as opaque — extractor is canonical producer.';

COMMENT ON COLUMN "code_symbols"."kind" IS
  'function | class | method | type | variable | interface | enum | namespace. Free-form text so adding kinds (e.g. decorator, jsx-component) does not require a CHECK migration.';

COMMENT ON COLUMN "code_symbols"."ast_hash" IS
  'SHA-256 hex of the normalized AST node. Used by Phase 1.3 indexer for incremental skip-when-unchanged.';

-- ── code_references ────────────────────────────────────────────────────────
-- Every USE site of a symbol — calls, imports, type references, extends,
-- implements, JSX elements. Powers `findReferences()` and `blastRadius()`.
-- `source_symbol_id` is nullable because file-scope statements (e.g. a
-- top-level import) have no enclosing symbol owner.

CREATE TABLE IF NOT EXISTS "code_references" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id"          uuid NOT NULL REFERENCES "code_repositories"("id") ON DELETE CASCADE,
  "source_symbol_id" uuid REFERENCES "code_symbols"("id") ON DELETE CASCADE,
  "target_symbol_id" uuid NOT NULL REFERENCES "code_symbols"("id") ON DELETE CASCADE,
  "file_path"        text NOT NULL,
  "line"             integer NOT NULL,
  "col"              integer,
  "kind"             text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_code_references_target"
  ON "code_references" ("target_symbol_id");

CREATE INDEX IF NOT EXISTS "idx_code_references_source"
  ON "code_references" ("source_symbol_id");

CREATE INDEX IF NOT EXISTS "idx_code_references_repo"
  ON "code_references" ("repo_id");

COMMENT ON TABLE "code_references" IS
  'Code Intelligence v2 — exact use-sites of every symbol. Drives findReferences/blastRadius queries. source_symbol_id NULL = file-scope reference (e.g. top-level import).';

COMMENT ON COLUMN "code_references"."kind" IS
  'call | import | type_ref | extends | implements | re_export | jsx_use. Free-form text for the same reason as code_symbols.kind.';

-- ── code_type_facts ────────────────────────────────────────────────────────
-- Structured type information per symbol. Stored separately from code_symbols
-- so symbol writes don't have to carry JSONB payloads, and so type-fact
-- queries can index/scan a smaller hot path.

CREATE TABLE IF NOT EXISTS "code_type_facts" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "symbol_id"      uuid NOT NULL REFERENCES "code_symbols"("id") ON DELETE CASCADE,
  "param_types"    jsonb,
  "return_type"    text,
  "generic_params" jsonb,
  "throws"         jsonb,
  "side_effects"   jsonb
);

CREATE INDEX IF NOT EXISTS "idx_code_type_facts_symbol"
  ON "code_type_facts" ("symbol_id");

COMMENT ON TABLE "code_type_facts" IS
  'Code Intelligence v2 — structured type info per symbol. Enriches search results and feeds container-agent type_at tool.';

COMMENT ON COLUMN "code_type_facts"."param_types" IS
  'Array of {name, type, optional, default} for parameters.';

COMMENT ON COLUMN "code_type_facts"."side_effects" IS
  '{reads_db, writes_db, calls_external: string[]} — used by remediation gates to flag risky symbols.';

-- ── code_imports ───────────────────────────────────────────────────────────
-- File-to-file import graph. Used by Phase 1.3 indexer for incremental
-- invalidation: when a file changes, every file that imports it is queued
-- for symbol re-extraction.

CREATE TABLE IF NOT EXISTS "code_imports" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id"        uuid NOT NULL REFERENCES "code_repositories"("id") ON DELETE CASCADE,
  "source_file"    text NOT NULL,
  "target_module"  text NOT NULL,
  "resolved_file"  text,
  "imported_names" jsonb
);

CREATE INDEX IF NOT EXISTS "idx_code_imports_source"
  ON "code_imports" ("repo_id", "source_file");

CREATE INDEX IF NOT EXISTS "idx_code_imports_target"
  ON "code_imports" ("repo_id", "resolved_file");

COMMENT ON TABLE "code_imports" IS
  'Code Intelligence v2 — file→file import edges. resolved_file NULL = external module (e.g. react). Used by indexer for transitive invalidation when a file changes.';

COMMENT ON COLUMN "code_imports"."imported_names" IS
  'Array of imported names. Each entry is either a string ("validateUser") or an object ({local, original}) when a name is aliased on import.';
