"use client";

import { useState, useTransition } from "react";
import { Copy, Check, Plus, Trash2, Terminal } from "lucide-react";
import { generateMcpToken, revokeMcpToken } from "./actions";
import { formatRelativeTime } from "@/lib/utils";

type McpTokenRow = {
  id: string;
  name: string;
  tokenPreview: string;
  lastUsedAt: string | null;
  createdAt: string;
};

export function McpTokenSection({ tokens }: { tokens: McpTokenRow[] }) {
  const [newToken, setNewToken] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write" | "execute">("read");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  const handleGenerate = () => {
    setError(null);
    start(async () => {
      const res = await generateMcpToken(name, scope);
      if (res.error) {
        setError(res.error);
      } else if (res.token) {
        setNewToken(res.token);
        setName("");
      }
    });
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevoke = (tokenId: string) => {
    start(async () => {
      await revokeMcpToken(tokenId);
      if (newToken) setNewToken(null);
    });
  };

  return (
    <div className="py-3 space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-medium bg-surface-dim text-fg-base/50 mt-0.5">
          <Terminal className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-fg-base">MCP Access Tokens</p>
          <p className="mt-0.5 text-sm text-fg-base/60">
            Connect any AI coding tool to InariWatch — Claude Code, Cursor, Windsurf, Codex CLI, Gemini CLI.
          </p>
        </div>
      </div>

      {/* Existing tokens */}
      {tokens.length > 0 && (
        <div className="divide-y divide-line-subtle rounded-lg border border-line bg-surface-inner">
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-fg-base font-medium">{t.name}</p>
                <p className="text-xs text-fg-base/50 font-mono">
                  {t.tokenPreview}
                  {t.lastUsedAt
                    ? ` — last used ${formatRelativeTime(new Date(t.lastUsedAt))}`
                    : " — never used"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleRevoke(t.id)}
                disabled={isPending}
                className="text-fg-base/50 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50"
                aria-label={`Revoke token ${t.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Generate new token */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Token name (e.g. Cursor, Claude Code)"
          maxLength={64}
          className="flex-1 rounded-lg border border-line bg-surface-inner px-3 py-1.5 text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent focus:outline-none"
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "read" | "write" | "execute")}
          className="rounded-lg border border-line bg-surface-inner px-2 py-1.5 text-xs text-fg-base focus:border-inari-accent focus:outline-none"
        >
          <option value="read">Read only</option>
          <option value="write">Read + Write</option>
          <option value="execute">Full access</option>
        </select>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={isPending || !name.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-fg-base/60 hover:border-fg-base/30 hover:text-fg-base transition-all disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {isPending ? "Generating..." : "Create token"}
        </button>
      </div>

      {error && <p className="text-[11px] text-red-600 dark:text-red-400" role="alert">{error}</p>}

      {/* Show newly created token */}
      {newToken && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-inari-accent/30 bg-inari-accent-dim px-3 py-2">
            <p className="flex-1 font-mono text-[12px] text-fg-base break-all">{newToken}</p>
            <button
              type="button"
              onClick={() => handleCopy(newToken)}
              className="shrink-0 text-fg-base/50 hover:text-fg-base transition-colors"
              aria-label="Copy token"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          </div>
          <p className="text-[11px] text-amber-600/80">
            Save this token now — it won't be shown again.
          </p>
        </div>
      )}

      {/* Quick setup guide */}
      {(tokens.length > 0 || newToken) && (
        <div className="rounded-lg border border-line bg-surface-inner px-4 py-3 space-y-2">
          <p className="text-xs font-medium text-fg-base/60">Quick setup</p>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <code className="text-[11px] text-fg-base/50 font-mono flex-1">
                claude mcp add inariwatch https://mcp.inariwatch.com --transport http -H &quot;Authorization: Bearer {'<token>'}&quot;
              </code>
              <button
                type="button"
                onClick={() => handleCopy(`claude mcp add inariwatch https://mcp.inariwatch.com --transport http -H "Authorization: Bearer ${newToken || '<your-token>'}"`) }
                className="shrink-0 text-fg-base/40 hover:text-fg-base transition-colors"
                aria-label="Copy setup command"
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
            <p className="text-[10px] text-fg-base/40">
              Works with Claude Code, Cursor, Windsurf, VS Code Copilot, Codex CLI, Gemini CLI
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
