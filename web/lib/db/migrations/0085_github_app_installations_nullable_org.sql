-- 0085 — github_app_installations.organization_id becomes nullable.
--
-- The original 0075 migration set organization_id NOT NULL because we
-- assumed every install had to live under an InariWatch workspace. For
-- solo founders / personal accounts that's overhead — the user has no
-- collaborators, no billing, no reason to spawn a synthetic org just so
-- the FK is satisfied.
--
-- After 0085 a row may have organization_id = NULL ("personal install");
-- the installer is tracked via installed_by (already nullable). Rows
-- still flow through the same setup callback; downstream queries
-- (`/projects` etc.) treat installation_id + organization_id IS NULL as
-- the user's personal workspace.

ALTER TABLE github_app_installations
  ALTER COLUMN organization_id DROP NOT NULL;

COMMENT ON COLUMN github_app_installations.organization_id IS
  'NULL = personal install (no workspace). Set = install belongs to that org. Migration 0085.';
