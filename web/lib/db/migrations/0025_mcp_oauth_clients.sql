-- Registered OAuth clients with allowed redirect URIs
CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" text NOT NULL,
  "name" text NOT NULL,
  "redirect_uris" text[] NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_oauth_clients_client_id_unique" UNIQUE ("client_id")
);

-- Seed known MCP clients (IDE tools)
INSERT INTO "mcp_oauth_clients" ("client_id", "name", "redirect_uris") VALUES
  ('claude-code', 'Claude Code', '{"http://localhost:*","https://claude.ai/*"}'),
  ('cursor', 'Cursor', '{"http://localhost:*","https://cursor.sh/*"}'),
  ('windsurf', 'Windsurf', '{"http://localhost:*","https://windsurf.ai/*"}'),
  ('vscode-copilot', 'VS Code Copilot', '{"http://localhost:*","https://vscode.dev/*"}'),
  ('codex-cli', 'Codex CLI', '{"http://localhost:*"}'),
  ('gemini-cli', 'Gemini CLI', '{"http://localhost:*"}')
ON CONFLICT (client_id) DO NOTHING;
