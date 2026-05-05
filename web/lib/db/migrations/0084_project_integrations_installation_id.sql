-- 0084 — link project_integrations to github_app_installations
--
-- Adds a nullable installation_id BIGINT to project_integrations so a GitHub
-- integration row can be backed by either:
--   • a PAT (legacy path: configEncrypted.token + .owner)
--   • a GitHub App installation (configEncrypted.owner + installation_id;
--     the installation token is fetched on demand via getInstallationToken)
--
-- The PAT path stays first-class until GITHUB_APP_ID + private key are
-- provisioned in production; once provisioned, the connect modal switches
-- to "Install GitHub App" and new rows arrive with installation_id populated.
-- Old PAT rows continue to work — the resolver in lib/services/github-token.ts
-- prefers installation_id when present and falls back to configEncrypted.token.

ALTER TABLE project_integrations
  ADD COLUMN IF NOT EXISTS installation_id BIGINT;

-- Partial index — only github rows linked to an installation. Lets the poll
-- route join to github_app_installations cheaply when the App path takes over.
CREATE INDEX IF NOT EXISTS project_integrations_installation_idx
  ON project_integrations(installation_id)
  WHERE installation_id IS NOT NULL;

COMMENT ON COLUMN project_integrations.installation_id IS
  'When set, the row authenticates against GitHub via the App installation token (mint via getInstallationToken). When NULL, falls back to PAT in configEncrypted.token. Migration 0084.';
