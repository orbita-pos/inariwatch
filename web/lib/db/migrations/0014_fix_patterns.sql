-- Fix Replay API: shared error patterns and community fixes

-- Error patterns (deduplicated across all users)
CREATE TABLE "error_patterns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "fingerprint" text NOT NULL UNIQUE,
  "pattern_text" text NOT NULL,
  "category" text NOT NULL,
  "framework" text,
  "language" text,
  "occurrence_count" integer DEFAULT 1 NOT NULL,
  "first_seen_at" timestamptz DEFAULT NOW() NOT NULL,
  "last_seen_at" timestamptz DEFAULT NOW() NOT NULL,
  "created_at" timestamptz DEFAULT NOW() NOT NULL
);

CREATE INDEX "idx_patterns_fingerprint" ON "error_patterns" ("fingerprint");
CREATE INDEX "idx_patterns_category" ON "error_patterns" ("category", "language");

-- Community fixes (anonymized)
CREATE TABLE "community_fixes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pattern_id" uuid NOT NULL REFERENCES "error_patterns"("id") ON DELETE CASCADE,
  "fix_approach" text NOT NULL,
  "fix_description" text NOT NULL,
  "files_changed_summary" text,
  "avg_confidence" integer DEFAULT 0 NOT NULL,
  "success_count" integer DEFAULT 0 NOT NULL,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "total_applications" integer DEFAULT 0 NOT NULL,
  "contributed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT NOW() NOT NULL,
  "updated_at" timestamptz DEFAULT NOW() NOT NULL
);

CREATE INDEX "idx_fixes_pattern" ON "community_fixes" ("pattern_id");
CREATE INDEX "idx_fixes_success" ON "community_fixes" ("success_count" DESC);

-- Fix ratings (crowd accuracy feedback)
CREATE TABLE "fix_ratings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "fix_id" uuid NOT NULL REFERENCES "community_fixes"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "worked" boolean NOT NULL,
  "rating" integer CHECK ("rating" >= 1 AND "rating" <= 5),
  "created_at" timestamptz DEFAULT NOW() NOT NULL,
  UNIQUE("fix_id", "user_id")
);
