-- 0086 — unique (provider, provider_account_id) on the accounts table.
--
-- The accounts table has been part of the schema since the NextAuth
-- adapter days but never populated by the JWT-strategy auth flow we
-- actually run. We're starting to populate it (in lib/auth.ts) so that
-- a user who linked GitHub once can sign back in with GitHub later
-- and resolve to the SAME user row, regardless of which email GitHub
-- returns. The lookup is by (provider, provider_account_id) — the
-- GitHub user id is stable, the email isn't.
--
-- Adding a unique index here makes the upsert race-safe (ON CONFLICT
-- DO UPDATE) and prevents accidental duplicates if two parallel
-- OAuth callbacks fire for the same user.
--
-- Safe to run on existing dbs: the table is empty in production
-- (verified — no code path writes to it before this migration).

CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_account_unique
  ON accounts (provider, provider_account_id);
