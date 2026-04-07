<p align="center">
  <img src="https://app.inariwatch.com/logo.svg" alt="InariWatch" width="60" />
</p>

<h1 align="center">@inariwatch/mcp</h1>

<p align="center">
  One command to connect all your AI coding tools to <a href="https://inariwatch.com">InariWatch</a>.<br/>
  Auto-detects. Auto-configures. Zero friction.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@inariwatch/mcp"><img src="https://img.shields.io/npm/v/@inariwatch/mcp.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@inariwatch/mcp"><img src="https://img.shields.io/npm/dm/@inariwatch/mcp.svg" alt="npm downloads" /></a>
  <a href="https://github.com/orbita-pos/inariwatch-mcp/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@inariwatch/mcp.svg" alt="license" /></a>
</p>

---

```bash
npx @inariwatch/mcp init
```

That's it. Here's what happens:

```
InariWatch Setup

  AI tools
    ✓ Claude Code (1.0.16)
    ✓ Cursor
    ✓ VS Code + Copilot (1.96.0)
    ✗ Windsurf
    ✗ Codex CLI
    ✓ Gemini CLI (0.1.8)
    ✓ GitHub CLI (username)

  Project
    ● Next.js detected — will install @inariwatch/capture

  Authenticating via browser...
  Code: ABC123
  Opening: https://app.inariwatch.com/cli/verify?code=ABC123

  Configuring MCP
    ✓ Claude Code
    ✓ Cursor
    ✓ VS Code + Copilot
    ✓ Gemini CLI

  Link GitHub (username) to InariWatch? (y/N) y
    ✓ GitHub linked (username)

  Installing @inariwatch/capture
    ✓ @inariwatch/capture installed
    ✓ next.config wrapped with withInariWatch
    ✓ instrumentation.ts created

  Enable Substrate I/O recording? (y/N) y
    ✓ INARIWATCH_SUBSTRATE=true added to .env

  Done! MCP in 4 tools + capture SDK + Substrate I/O.
```

## What it does

| Step | What happens | You do |
|------|-------------|--------|
| **Detect** | Scans your machine for AI coding tools | Nothing |
| **Auth** | Opens browser for secure device-flow login | Click "Approve" |
| **Configure MCP** | Writes MCP config to every detected tool | Nothing |
| **Install SDK** | Adds `@inariwatch/capture` to your project | Nothing |
| **Link GitHub** | Connects your GitHub account | Type `y` (optional) |

**One command. Five steps. All automatic.**

## Supported tools

| Tool | Detection | MCP config location |
|------|-----------|-------------------|
| **Claude Code** | `claude` in PATH | `claude mcp add` |
| **Cursor** | Config directory | `~/.cursor/mcp.json` |
| **Windsurf** | Config directory | `~/.windsurf/mcp.json` |
| **VS Code + Copilot** | `code` in PATH | `.vscode/mcp.json` |
| **Codex CLI** | `codex` in PATH | `codex mcp add` |
| **Gemini CLI** | `gemini` in PATH | `gemini mcp add` |

Works on **macOS**, **Linux**, and **Windows**. Paths resolve per-platform automatically.

## What your AI tool gets

Once configured, your AI coding tool has access to **25 MCP tools**:

| Tool | What it does |
|------|-------------|
| `query_alerts` | Search and filter your alerts |
| `trigger_fix` | Start AI-powered remediation |
| `assess_risk` | Analyze PR risk before merge |
| `search_codebase` | Semantic code search (pgvector + BM25) |
| `get_root_cause` | AI root cause analysis |
| `rollback_vercel` | One-click deploy rollback |
| `ask_inari` | Chat with your monitoring data |
| `get_error_trends` | Error trend analytics |
| `run_health_check` | Production health check |
| `simulate_fix` | Test a fix before applying |
| ... | [15 more tools](https://inariwatch.com/docs#mcp) |

Plus **4 resources** (critical alerts, recent alerts, status overview, active remediations), **7 prompts** (diagnose, status-report, fix-this, post-deploy-check, weekly-summary, production-health-check, daily-report), and real-time alert streaming.

## Options

```bash
npx @inariwatch/mcp init [options]
```

| Flag | Description |
|------|-------------|
| `--token <token>` | Skip browser auth, use an existing API token |
| `--no-capture` | Skip `@inariwatch/capture` SDK installation |

## Framework detection

When run inside a Node.js project, init also installs the [`@inariwatch/capture`](https://www.npmjs.com/package/@inariwatch/capture) SDK:

| Framework | What it does |
|-----------|-------------|
| **Next.js** | Installs SDK, wraps `next.config` with `withInariWatch`, creates `instrumentation.ts` |
| **Node.js** | Installs SDK (use `--import @inariwatch/capture/auto` to activate) |

Detects your package manager automatically (npm, yarn, pnpm, bun).

## Manual setup

If you'd rather configure one tool manually:

**Claude Code:**
```bash
claude mcp add inariwatch https://mcp.inariwatch.com -t http -H "Authorization: Bearer YOUR_TOKEN"
```

**Cursor / Windsurf** — add to `mcp.json`:
```json
{
  "mcpServers": {
    "inariwatch": {
      "url": "https://mcp.inariwatch.com",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

**VS Code** — add to `.vscode/mcp.json`:
```json
{
  "servers": {
    "inariwatch": {
      "url": "https://mcp.inariwatch.com",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

Get your token at [app.inariwatch.com/settings](https://app.inariwatch.com/settings).

## How it works

The MCP server runs at `mcp.inariwatch.com` using Streamable HTTP (JSON-RPC 2.0). Auth uses Bearer tokens with SHA-256 hashing. Rate limits apply per tool tier:

| Tier | Limit | Tools |
|------|-------|-------|
| Cheap | 200/min | query_alerts, get_status, get_uptime |
| Moderate | 30/min | assess_risk, get_root_cause, ask_inari |
| Expensive | 5/min | trigger_fix, rollback_vercel, simulate_fix |

Every tool call is logged to the audit trail.

## Related packages

- [`@inariwatch/capture`](https://www.npmjs.com/package/@inariwatch/capture) — Error capture SDK (zero deps, zero config)
- [InariWatch VS Code](https://marketplace.visualstudio.com/items?itemName=inariwatch.inariwatch) — Inline diagnostics + AI hover
- [InariWatch GitHub Action](https://github.com/marketplace/actions/inariwatch-risk-assessment) — AI risk assessment on PRs

## License

[MIT](LICENSE)
