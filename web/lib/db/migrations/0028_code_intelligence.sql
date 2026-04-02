-- Code Intelligence (Code RAG) — pgvector + BM25 for codebase-aware AI fixes

-- Enable pgvector extension (Neon supports this natively)
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE code_repo_status AS ENUM ('pending', 'indexing', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE chunk_type AS ENUM ('function', 'class', 'method', 'module', 'type');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dep_type AS ENUM ('calls', 'imports', 'extends', 'implements');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Repositories ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "code_repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "github_owner" text NOT NULL,
  "github_repo" text NOT NULL,
  "default_branch" text NOT NULL DEFAULT 'main',
  "last_indexed_commit" text,
  "last_indexed_at" timestamptz,
  "total_chunks" integer NOT NULL DEFAULT 0,
  "status" code_repo_status NOT NULL DEFAULT 'pending',
  "error_message" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_code_repos_project" ON "code_repositories" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_code_repos_unique" ON "code_repositories" ("project_id", "github_owner", "github_repo");

-- ── Code Chunks (with embeddings + full-text search) ─────────────────────────

CREATE TABLE IF NOT EXISTS "code_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "code_repositories"("id") ON DELETE CASCADE,
  "file_path" text NOT NULL,
  "chunk_type" chunk_type NOT NULL,
  "name" text NOT NULL,
  "start_line" integer NOT NULL,
  "end_line" integer NOT NULL,
  "code" text NOT NULL,
  "docstring" text,
  "embedding" vector(1024),
  "language" text NOT NULL,
  "dependencies" text[] NOT NULL DEFAULT '{}',
  "tsv" tsvector,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_code_chunks_repo" ON "code_chunks" ("repo_id");
CREATE INDEX IF NOT EXISTS "idx_code_chunks_file" ON "code_chunks" ("repo_id", "file_path");

-- HNSW index for fast approximate nearest neighbor search (cosine distance)
CREATE INDEX IF NOT EXISTS "idx_code_chunks_embedding" ON "code_chunks"
  USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- GIN index for full-text search (BM25-style ranking via ts_rank)
CREATE INDEX IF NOT EXISTS "idx_code_chunks_tsv" ON "code_chunks" USING gin ("tsv");

-- Auto-update tsvector on INSERT/UPDATE
CREATE OR REPLACE FUNCTION code_chunks_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.tsv := setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A') ||
             setweight(to_tsvector('english', COALESCE(NEW.docstring, '')), 'B') ||
             setweight(to_tsvector('english', COALESCE(NEW.code, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_code_chunks_tsv ON "code_chunks";
CREATE TRIGGER trg_code_chunks_tsv
  BEFORE INSERT OR UPDATE OF name, docstring, code ON "code_chunks"
  FOR EACH ROW EXECUTE FUNCTION code_chunks_tsv_trigger();

-- ── Dependency Graph ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "code_dependencies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_chunk_id" uuid NOT NULL REFERENCES "code_chunks"("id") ON DELETE CASCADE,
  "target_chunk_id" uuid NOT NULL REFERENCES "code_chunks"("id") ON DELETE CASCADE,
  "dependency_type" dep_type NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_code_deps_source" ON "code_dependencies" ("source_chunk_id");
CREATE INDEX IF NOT EXISTS "idx_code_deps_target" ON "code_dependencies" ("target_chunk_id");
