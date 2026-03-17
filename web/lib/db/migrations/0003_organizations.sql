-- Organizations (workspaces)
DO $$ BEGIN
  CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'member');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "organizations" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name"       text NOT NULL,
  "slug"       text NOT NULL UNIQUE,
  "owner_id"   uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "avatar_url" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "organization_members" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"         uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role"            "org_role" DEFAULT 'member' NOT NULL,
  "joined_at"       timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "organization_invites" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "email"           text NOT NULL,
  "role"            "org_role" DEFAULT 'member' NOT NULL,
  "invited_by"      uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "token"           text NOT NULL UNIQUE,
  "created_at"      timestamp DEFAULT now() NOT NULL,
  "expires_at"      timestamp NOT NULL
);

-- Add organization_id to projects (nullable — personal projects have no org)
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "organization_id" uuid REFERENCES "organizations"("id") ON DELETE SET NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS "idx_org_members_org"  ON "organization_members"("organization_id");
CREATE INDEX IF NOT EXISTS "idx_org_members_user" ON "organization_members"("user_id");
CREATE INDEX IF NOT EXISTS "idx_org_invites_org"  ON "organization_invites"("organization_id");
CREATE INDEX IF NOT EXISTS "idx_org_invites_token" ON "organization_invites"("token");
CREATE INDEX IF NOT EXISTS "idx_projects_org"     ON "projects"("organization_id");

-- Unique constraints to prevent race-condition duplicates
CREATE UNIQUE INDEX IF NOT EXISTS "uq_org_members_org_user"  ON "organization_members"("organization_id", "user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_org_invites_org_email" ON "organization_invites"("organization_id", "email");
