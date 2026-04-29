-- 0075 — GitHub App zero-install integration
--
-- Backs the GitHub Marketplace flow: user installs github.com/apps/inariwatch
-- on their org/repos, our App opens a "Set up InariWatch" PR (instrumentation.ts
-- + next.config wrap + package.json). User merges, sets INARIWATCH_DSN in their
-- hosting provider's env vars (we hand them the DSN in the PR body), next
-- deploy is monitored.
--
-- One table — github_app_installations. Vercel-marketplace path was considered
-- and dropped: GitHub App alone covers every hosting provider with one consent.

CREATE TABLE IF NOT EXISTS github_app_installations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id     BIGINT NOT NULL UNIQUE,
  account_login       TEXT NOT NULL,
  account_type        TEXT NOT NULL,           -- "User" or "Organization"
  account_id          BIGINT NOT NULL,
  setup_pr_url        TEXT,                    -- the auto-PR we opened (if any)
  setup_pr_owner      TEXT,
  setup_pr_repo       TEXT,
  setup_pr_number     INTEGER,
  installed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT now(),
  updated_at          TIMESTAMP NOT NULL DEFAULT now(),
  uninstalled_at      TIMESTAMP
);

CREATE INDEX IF NOT EXISTS github_app_installations_org_idx
  ON github_app_installations(organization_id) WHERE uninstalled_at IS NULL;
