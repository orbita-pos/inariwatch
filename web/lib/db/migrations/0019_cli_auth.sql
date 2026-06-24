CREATE TABLE IF NOT EXISTS cli_pending_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  approved boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS cli_pending_codes_code_idx ON cli_pending_codes (code);
