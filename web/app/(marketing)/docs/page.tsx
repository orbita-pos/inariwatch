import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { CopyButton } from "../copy-button";
import { MarketingNav } from "../marketing-nav";
import {
  Terminal,
  Zap,
  Github,
  AlertTriangle,
  Activity,
  Database,
  Package,
  Brain,
  MessageSquare,
  Monitor,
  Bell,
  ChevronRight,
  ExternalLink,
  Info,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Docs — InariWatch",
  description: "Documentation for InariWatch — CLI, integrations, AI setup, and the web dashboard.",
};

// ── Sidebar nav config ─────────────────────────────────────────────────────────

const NAV = [
  {
    group: "Getting started",
    items: [
      { id: "quickstart-web",  label: "Web dashboard" },
      { id: "quickstart-cli",  label: "Local CLI" },
    ],
  },
  {
    group: "CLI",
    items: [
      { id: "cli-install",    label: "Installation" },
      { id: "cli-commands",   label: "Commands" },
      { id: "cli-config",     label: "Configuration" },
      { id: "cli-daemon",     label: "Daemon" },
      { id: "cli-autofix",    label: "Auto-fix" },
      { id: "cli-mcp",        label: "MCP Server" },
      { id: "cli-rollback",   label: "Rollback" },
      { id: "cli-cron",       label: "Cron Scheduler" },
    ],
  },
  {
    group: "Integrations",
    items: [
      { id: "int-github",    label: "GitHub" },
      { id: "int-vercel",    label: "Vercel" },
      { id: "int-sentry",    label: "Sentry" },
      { id: "int-datadog",   label: "Datadog" },
      { id: "int-uptime",    label: "Uptime" },
      { id: "int-postgres",  label: "PostgreSQL" },
      { id: "int-npm",       label: "npm / Cargo" },
      { id: "int-capture",   label: "@inariwatch/capture" },
    ],
  },
  {
    group: "AI setup",
    items: [
      { id: "ai-overview",   label: "Overview (BYOK)" },
      { id: "ai-claude",     label: "Claude (Anthropic)" },
      { id: "ai-openai",     label: "OpenAI" },
      { id: "ai-grok",       label: "Grok (xAI)" },
      { id: "ai-deepseek",   label: "DeepSeek" },
      { id: "ai-gemini",     label: "Gemini (Google)" },
    ],
  },
  {
    group: "Notifications",
    items: [
      { id: "notif-telegram", label: "Telegram" },
      { id: "notif-email",    label: "Email" },
      { id: "notif-slack",    label: "Slack" },
      { id: "notif-push",     label: "Push (browser)" },
      { id: "notif-oncall",   label: "On-Call Schedules" },
      { id: "notif-overrides", label: "Schedule Overrides" },
      { id: "notif-storm",    label: "Incident Storm Control" },
      { id: "notif-ack",      label: "Interactive ACK" },
    ],
  },
  {
    group: "Desktop app",
    items: [
      { id: "desktop-setup",  label: "Setup & token" },
      { id: "desktop-config", label: "desktop.toml" },
    ],
  },
  {
    group: "Reference",
    items: [
      { id: "ref-alerts",     label: "Alert types & severity" },
      { id: "ref-api",        label: "REST API" },
    ],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="scroll-mt-20 text-xl font-semibold text-fg-strong mb-4 pt-10 first:pt-0 border-t border-line first:border-0 mt-10 first:mt-0"
    >
      {children}
    </h2>
  );
}

function SubHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="scroll-mt-20 text-base font-semibold text-fg-strong mt-8 mb-3">
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-fg-base leading-relaxed mb-3">{children}</p>;
}

function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <div className="my-4 overflow-hidden rounded-lg border border-line bg-zinc-950">
      {label && (
        <div className="border-b border-line px-4 py-2 flex items-center justify-between">
          <span className="font-mono text-[11px] text-zinc-500 uppercase tracking-wider">{label}</span>
          <CopyButton text={children.trim()} />
        </div>
      )}
      <pre className="overflow-x-auto p-4 font-mono text-sm text-zinc-300 leading-6 whitespace-pre">{children.trim()}</pre>
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-200">
      {children}
    </code>
  );
}

function Callout({ type = "info", children }: { type?: "info" | "warn" | "tip"; children: React.ReactNode }) {
  const styles = {
    info: "border-blue-900/40 bg-blue-950/20 text-blue-300",
    warn: "border-amber-900/40 bg-amber-950/20 text-amber-300",
    tip:  "border-inari-accent/30 bg-inari-accent/5 text-inari-accent",
  };
  const labels = { info: "Note", warn: "Warning", tip: "Pro tip" };
  return (
    <div className={`my-4 flex gap-3 rounded-lg border p-4 text-sm leading-relaxed ${styles[type]}`}>
      <Info className="mt-0.5 h-4 w-4 shrink-0 opacity-70" />
      <div>
        <span className="font-semibold">{labels[type]}: </span>
        {children}
      </div>
    </div>
  );
}

function StepList({ steps }: { steps: { title: string; body: React.ReactNode }[] }) {
  return (
    <ol className="my-4 space-y-4">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-4">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-inari-accent/40 bg-inari-accent/10 font-mono text-xs text-inari-accent">
            {i + 1}
          </span>
          <div className="pt-0.5">
            <p className="text-sm font-semibold text-fg-strong mb-1">{s.title}</p>
            <div className="text-sm text-fg-base leading-relaxed">{s.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="my-4 overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-inner">
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 text-left font-medium text-zinc-400 text-xs uppercase tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-subtle">
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? "bg-surface" : "bg-surface-inner/40"}>
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2.5 text-zinc-400 font-mono text-xs">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-inari-bg">
      <style>{`
        .docs-sidebar::-webkit-scrollbar { width: 3px; }
        .docs-sidebar::-webkit-scrollbar-track { background: transparent; }
        .docs-sidebar::-webkit-scrollbar-thumb {
          background: rgba(124,58,237,0.25);
          border-radius: 9999px;
          transition: background 0.2s;
        }
        .docs-sidebar:hover::-webkit-scrollbar-thumb { background: rgba(124,58,237,0.55); }
        .docs-sidebar { scrollbar-width: thin; scrollbar-color: rgba(124,58,237,0.25) transparent; }
      `}</style>
      <MarketingNav opaque />

      <div className="mx-auto max-w-6xl px-6 pt-20">
        <div className="flex gap-10 lg:gap-16">

          {/* ── Sidebar ────────────────────────────────────────────────────── */}
          <aside className="docs-sidebar hidden lg:block w-52 shrink-0 sticky top-20 h-[calc(100vh-5rem)] overflow-y-auto">
            <div className="py-6 space-y-6">
              {NAV.map((section) => (
                <div key={section.group}>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                    {section.group}
                  </p>
                  <ul className="space-y-0.5">
                    {section.items.map((item) => (
                      <li key={item.id}>
                        <a
                          href={`#${item.id}`}
                          className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-fg-base"
                        >
                          <ChevronRight className="h-3 w-3 shrink-0 opacity-40" />
                          {item.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </aside>

          {/* ── Content ────────────────────────────────────────────────────── */}
          <main className="min-w-0 flex-1 py-8 pb-32">

            {/* Page header */}
            <div className="mb-10 border-b border-line pb-8">
              <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-2">Documentation</p>
              <h1 className="text-3xl font-bold text-fg-strong">InariWatch Docs</h1>
              <p className="mt-3 text-fg-base">
                Everything you need to set up InariWatch — web dashboard, local CLI, integrations, and AI.
              </p>
            </div>

            {/* ────────────────────────────────────────────────────────────────
                GETTING STARTED
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="quickstart-web">Web dashboard</SectionHeading>
            <P>
              The web dashboard is the fastest way to get started — no install, no card required.
              Sign up, connect your first integration, and InariWatch starts monitoring in minutes.
            </P>
            <StepList steps={[
              {
                title: "Create an account",
                body: <>Go to <Link href="/register" className="text-inari-accent underline underline-offset-2">inariwatch.com/register</Link> and sign up with GitHub or email.</>,
              },
              {
                title: "Create a project",
                body: "A project groups your integrations and alerts. Give it the name of your app or service.",
              },
              {
                title: "Connect an integration",
                body: <>Go to <strong>Integrations</strong> and connect GitHub, Vercel, or Sentry. See the <a href="#int-github" className="text-inari-accent underline underline-offset-2">integration guides</a> below for exactly which token to use.</>,
              },
              {
                title: "(Optional) Add your AI key",
                body: <>Go to <strong>Settings → AI analysis</strong> and paste your API key. See <a href="#ai-overview" className="text-inari-accent underline underline-offset-2">AI setup</a> for all supported providers.</>,
              },
            ]} />
            <Callout type="info">
              The InariWatch Cloud Dashboard polls connected services every 5 minutes (uptime checks every 1 minute) to detect issues instantly.
            </Callout>

            <SectionHeading id="quickstart-cli">Local CLI</SectionHeading>
            <P>
              The CLI runs entirely on your machine — no account needed, data stays local.
              It's the best option if you prefer a terminal workflow or want zero cloud dependency.
            </P>
            <CodeBlock label="Install">{`curl -fsSL https://get.inariwatch.com | sh`}</CodeBlock>
            <StepList steps={[
              {
                title: "Create a project",
                body: <><InlineCode>inariwatch init</InlineCode> — walks you through creating a local project interactively.</>,
              },
              {
                title: "Add an integration",
                body: <><InlineCode>inariwatch add github</InlineCode> — prompts for your token and owner. Repeat for vercel, sentry, etc.</>,
              },
              {
                title: "(Optional) Set an AI key",
                body: <><InlineCode>inariwatch config --ai-key sk-ant-...</InlineCode> — enables AI correlation and auto-remediation in the watch loop.</>,
              },
              {
                title: "Start watching",
                body: <><InlineCode>inariwatch watch</InlineCode> — polls every 60s, correlates events, and sends Telegram alerts if configured.</>,
              },
            ]} />

            {/* ────────────────────────────────────────────────────────────────
                CLI
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="cli-install">CLI — Installation</SectionHeading>
            <P>The CLI is a single Rust binary with no runtime dependencies.</P>
            <CodeBlock label="Linux / macOS">{`curl -fsSL https://get.inariwatch.com | sh`}</CodeBlock>
            <CodeBlock label="Windows (PowerShell)">{`irm https://get.inariwatch.com/install.ps1 | iex`}</CodeBlock>
            <CodeBlock label="Build from source">{`git clone https://github.com/orbita-pos/inariwatch
cd inariwatch/cli
cargo build --release
# binary at: ./target/release/inariwatch`}</CodeBlock>
            <P>
              After installing, run <InlineCode>inariwatch --help</InlineCode> to confirm it works.
              On Linux/macOS the binary is placed in <InlineCode>~/.local/bin/inariwatch</InlineCode>.
              On Windows it installs to <InlineCode>%USERPROFILE%\.inariwatch\bin</InlineCode> and is added to your user PATH automatically.
            </P>

            <SectionHeading id="cli-commands">CLI — Commands</SectionHeading>
            <Table
              head={["Command", "Description"]}
              rows={[
                ["inariwatch init",                   "Create a new local project (interactive)"],
                ["inariwatch add github",              "Add GitHub integration — prompts for token + owner + repos"],
                ["inariwatch add vercel",              "Add Vercel integration — prompts for token + team ID"],
                ["inariwatch add sentry",              "Add Sentry integration — prompts for auth token + org slug"],
                ["inariwatch add git",                 "Add local git integration (no token needed)"],
                ["inariwatch add uptime",              "Add uptime monitoring — prompts for URL + optional threshold"],
                ["inariwatch add cron",                "Add cron scheduler — prompts for base URL + secret"],
                ["inariwatch connect telegram",        "Link a Telegram bot for notifications"],
                ["inariwatch watch",                   "Main loop — polls every 60s, sends alerts, runs AI correlation"],
                ["inariwatch status",                  "Show integration health and last poll times"],
                ["inariwatch logs",                    "Show recent alerts from the local SQLite database"],
                ["inariwatch config --ai-key <key>",        "Set AI key (Claude, OpenAI, Grok, DeepSeek, or Gemini)"],
                ["inariwatch config --model <model>",       "Set the AI model"],
                ["inariwatch config --auto-fix true",       "Enable autonomous AI fix pipeline on critical alerts"],
                ["inariwatch config --auto-merge true",     "Auto-merge generated PRs when all safety gates pass"],
                ["inariwatch config --show",                "Print current config (keys masked)"],
                ["inariwatch daemon install",               "Register InariWatch as a background service (systemd / launchd / Task Scheduler)"],
                ["inariwatch daemon start|stop|status",     "Control the background daemon"],
                ["inariwatch daemon uninstall",             "Remove the background service"],
                ["inariwatch agent-stats",                  "Show AI agent track record, trust level, and auto-merge gates"],
                ["inariwatch serve-mcp",                    "Start an MCP server over stdio (Claude Code, Cursor, etc.)"],
                ["inariwatch rollback vercel",              "Interactive rollback — pick a previous deployment to restore"],
              ]}
            />

            <SectionHeading id="cli-config">CLI — Configuration</SectionHeading>
            <P>The CLI stores all config in two files:</P>
            <Table
              head={["File", "Purpose"]}
              rows={[
                ["~/.config/inariwatch/config.toml",        "AI key, model, and per-project integration tokens"],
                ["~/.local/share/inariwatch/inariwatch.db",      "SQLite — events and alerts (local history)"],
              ]}
            />
            <CodeBlock label="~/.config/inariwatch/config.toml (example)">{`[global]
ai_key    = "sk-ant-..."
ai_model  = "claude-haiku-4-5-20251001"
auto_fix  = false   # enable autonomous fix pipeline on critical alerts
auto_merge = false  # auto-merge PRs when all safety gates pass

[[projects]]
name = "my-app"
slug = "my-app"
path = "/home/you/projects/my-app"

[projects.integrations.github]
token         = "ghp_..."
repo          = "my-org/my-app"
stale_pr_days = 2

[projects.integrations.vercel]
token      = "..."
project_id = "prj_..."
team_id    = "team_..."   # optional

[projects.integrations.sentry]
token   = "..."
org     = "my-org"
project = "my-project"

[projects.integrations.uptime]
url       = "https://my-app.com"
threshold = 5000   # ms — optional, alerts if response > threshold

[projects.integrations.cron]
url    = "https://app.inariwatch.com"
secret = "your-cron-secret"

[projects.notifications.telegram]
bot_token = "123456:ABC-..."
chat_id   = "987654321"`}</CodeBlock>
            <Callout type="info">
              You can edit this file directly, but using <InlineCode>inariwatch add</InlineCode> and <InlineCode>inariwatch config</InlineCode> is safer — they validate tokens before saving.
            </Callout>

            {/* ────────────────────────────────────────────────────────────────
                CLI DAEMON
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="cli-daemon">CLI — Daemon</SectionHeading>
            <P>
              Run InariWatch as a background service so it monitors your project 24/7 — even when your terminal is closed.
              It registers as a <strong>systemd user service</strong> on Linux, a <strong>launchd agent</strong> on macOS,
              and a <strong>Task Scheduler task</strong> on Windows.
            </P>
            <CodeBlock label="Terminal">{`inariwatch daemon install   # register and enable the service
inariwatch daemon start     # start immediately
inariwatch daemon stop      # stop the service
inariwatch daemon status    # check if running + tail recent logs
inariwatch daemon uninstall # remove the service`}</CodeBlock>
            <P>
              Logs are written to <InlineCode>~/.inariwatch/daemon.log</InlineCode> on all platforms.
              The daemon runs <InlineCode>inariwatch watch</InlineCode> in the background — any config you set
              with <InlineCode>inariwatch config</InlineCode> applies to it automatically.
            </P>

            {/* ────────────────────────────────────────────────────────────────
                CLI AUTO-FIX
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="cli-autofix">CLI — Auto-fix &amp; Auto-merge</SectionHeading>
            <P>
              When <InlineCode>auto_fix</InlineCode> is enabled, every critical alert automatically triggers the full
              AI remediation pipeline: diagnose → read code → generate fix → self-review → push branch → wait CI → open PR.
              No human needed until the PR appears.
            </P>
            <CodeBlock label="Terminal">{`inariwatch config --auto-fix true    # enable autonomous fix pipeline
inariwatch config --auto-merge true  # also merge PRs when all safety gates pass`}</CodeBlock>
            <P>
              <InlineCode>auto_merge</InlineCode> requires <InlineCode>auto_fix</InlineCode> to be enabled.
              Even then, a PR is only merged when <strong>all 5 safety gates pass</strong>: CI green, confidence ≥ 90%,
              self-review score ≥ 70, lines changed ≤ 50, and trust level ≥ Apprentice.
            </P>
            <Callout type="info">
              Use <InlineCode>inariwatch agent-stats</InlineCode> to see the AI&apos;s track record, current trust level,
              and which gates apply at your trust level. The agent earns relaxed gates as it accumulates successful fixes.
            </Callout>
            <Table
              head={["Trust level", "Requires", "Auto-merge gates"]}
              rows={[
                ["Rookie",     "0 fixes",              "Never auto-merges"],
                ["Apprentice", "3 fixes, ≥ 50% success", "Conf ≥ 90, lines ≤ 50"],
                ["Trusted",    "5 fixes, ≥ 70% success", "Conf ≥ 80, lines ≤ 100"],
                ["Expert",     "10 fixes, ≥ 85% success", "Conf ≥ 70, lines ≤ 200"],
              ]}
            />

            {/* ────────────────────────────────────────────────────────────────
                CLI MCP SERVER
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="cli-mcp">CLI — MCP Server</SectionHeading>
            <P>
              InariWatch exposes an <strong>MCP (Model Context Protocol) server</strong> that gives your AI editor direct access
              to your alerts, integrations, and infrastructure actions — without leaving your code.
              Works with <strong>Claude Code</strong>, <strong>Cursor</strong>, <strong>Windsurf</strong>, <strong>VS Code</strong>, and any MCP-compatible client.
            </P>
            <P>
              The MCP server has two tiers of tools: <strong>read tools</strong> to query alerts and run checks,
              and <strong>action tools</strong> that let the AI autonomously fix issues, roll back deploys, and silence alerts.
            </P>

            <SubHeading id="cli-mcp-connect">Connecting to your editor</SubHeading>
            <P>Add InariWatch to your <InlineCode>.mcp.json</InlineCode> (project-level) or your editor&apos;s global MCP config:</P>
            <CodeBlock label=".mcp.json">{`{
  "mcpServers": {
    "inariwatch": {
      "command": "inariwatch",
      "args": ["serve-mcp"]
    }
  }
}`}</CodeBlock>
            <P>
              For <strong>Cursor</strong>: Settings → MCP → Add server → paste the config above.<br />
              For <strong>Claude Code</strong>: save as <InlineCode>.mcp.json</InlineCode> in your project root or <InlineCode>~/.claude/settings.json</InlineCode> globally.<br />
              Then reload your editor — InariWatch starts automatically when the AI needs it.
            </P>

            <SubHeading id="cli-mcp-tools">Available tools</SubHeading>
            <Table
              head={["Tool", "Type", "Description"]}
              rows={[
                ["query_alerts",    "read",   "Fetch recent alerts from local DB. Filterable by project, severity, and limit."],
                ["get_status",      "read",   "List configured projects and active integrations."],
                ["run_check",       "read",   "Trigger one monitoring cycle and return any new alerts found."],
                ["get_root_cause",  "action", "Deep AI analysis of an alert: root cause, confidence, impact, and prevention steps. Pulls context from Sentry, Vercel, and GitHub in parallel."],
                ["trigger_fix",     "action", "Full autonomous remediation: diagnose → read code → AI fix → self-review → branch → CI wait → PR → optional auto-merge. Supports dry_run to preview without side effects."],
                ["rollback_vercel", "action", "Roll back a Vercel project to the last successful production deployment. Accepts an optional deployment ID."],
                ["get_build_logs",  "action", "Fetch Vercel build logs for a deployment with error extraction. Defaults to the latest failed deploy."],
                ["silence_alert",   "action", "Mark an alert as read in the local database."],
              ]}
            />
            <Callout type="tip">
              With the MCP server active you can tell your editor: <em>&ldquo;Fix that Sentry error&rdquo;</em> — the AI will call <InlineCode>query_alerts</InlineCode> to find it,
              then <InlineCode>trigger_fix</InlineCode> to diagnose, generate a fix, push a branch, wait for CI, and open a PR — all without leaving your editor.
            </Callout>

            {/* ────────────────────────────────────────────────────────────────
                CLI ROLLBACK
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="cli-rollback">CLI — Rollback</SectionHeading>
            <P>
              When a bad deploy reaches production, <InlineCode>inariwatch rollback vercel</InlineCode> gives you an interactive list
              of your last 10 successful deployments so you can pick one and restore it in seconds.
            </P>
            <CodeBlock label="Terminal">{`inariwatch rollback vercel

Fetching recent successful deployments for my-app…
? Roll back to which deployment?
> dpl_abc123 a1b2c3d (main) — fix: remove debug log — 2h ago
  dpl_def456 e4f5g6h (main) — feat: add dark mode  — 5h ago
  dpl_ghi789 i7j8k9l (main) — chore: bump deps     — 1d ago

  Deploy:  dpl_abc12345
  Branch:  main
  Commit:  a1b2c3d
  URL:     https://my-app.vercel.app

? Confirm rollback to production? (y/N) y
Rolling back…
✓ Rollback triggered!
  Live at: https://my-app.vercel.app`}</CodeBlock>
            <Callout type="info">
              The confirmation prompt defaults to <strong>No</strong> — you have to explicitly type <InlineCode>y</InlineCode> to proceed. This prevents accidental rollbacks.
            </Callout>

            {/* ────────────────────────────────────────────────────────────────
                CLI CRON SCHEDULER
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="cli-cron">CLI — Cron Scheduler</SectionHeading>
            <P>
              The CLI includes a built-in cron scheduler that replaces external services like GitHub Actions
              for triggering InariWatch cloud endpoints. It runs inside the <InlineCode>inariwatch watch</InlineCode> loop
              and fires HTTP requests to your configured cron tasks at their defined intervals.
            </P>
            <CodeBlock label="Terminal">{`inariwatch add cron
# Prompts for:
#   Base URL:    https://app.inariwatch.com
#   Cron secret: your-cron-secret`}</CodeBlock>
            <P>
              Once configured, the watch loop automatically fires 4 default tasks:
            </P>
            <Table
              head={["Task", "Path", "Interval", "Purpose"]}
              rows={[
                ["poll",     "/api/cron/poll",     "5 min",  "Poll integrations for new alerts"],
                ["uptime",   "/api/cron/uptime",   "60 sec", "Check uptime endpoints"],
                ["escalate", "/api/cron/escalate", "5 min",  "Escalate unacknowledged alerts"],
                ["digest",   "/api/cron/digest",   "24 hr",  "Send daily alert digest emails"],
              ]}
            />
            <P>
              Each request includes an <InlineCode>Authorization: Bearer {'<secret>'}</InlineCode> header.
              All cron endpoints verify this secret using constant-time comparison.
            </P>
            <Callout type="info">
              You can customize tasks in <InlineCode>config.toml</InlineCode> — add new paths, change intervals, or disable specific tasks.
              SSRF protection is built in: the scheduler blocks requests to localhost, private IPs, and non-HTTP protocols.
            </Callout>

            {/* ────────────────────────────────────────────────────────────────
                INTEGRATIONS
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="int-github">Integration — GitHub</SectionHeading>
            <P>InariWatch uses a GitHub Personal Access Token (classic or fine-grained) to monitor CI runs, PRs, and commits.</P>

            <SubHeading id="int-github-token">Getting a token</SubHeading>
            <StepList steps={[
              {
                title: "Go to GitHub → Settings → Developer settings → Personal access tokens",
                body: <><a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">github.com/settings/tokens <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Create a new token (classic)",
                body: "Click Generate new token → Classic.",
              },
              {
                title: "Select scopes",
                body: (
                  <Table
                    head={["Scope", "Why"]}
                    rows={[
                      ["repo",              "Read CI runs, PRs, and commits on private repos"],
                      ["read:org",          "Read org membership (if monitoring an org)"],
                      ["read:user",         "Identify the token owner for auto-detection"],
                    ]}
                  />
                ),
              },
              {
                title: "Copy the token",
                body: <>The token starts with <InlineCode>ghp_</InlineCode>. Paste it into InariWatch.</>,
              },
            ]} />

            <SubHeading id="int-github-monitors">What InariWatch monitors</SubHeading>
            <Table
              head={["Alert", "Severity", "Default"]}
              rows={[
                ["Failed CI check on main/master",  "Critical", "On"],
                ["Failed CI on any branch",          "Warning",  "Off"],
                ["Stale PR (configurable days)",     "Warning",  "On — 3 days"],
                ["Unreviewed PR (configurable hrs)", "Warning",  "On — 24 hrs"],
                ["Pre-deploy risk score on PR",      "Info",     "On (Requires AI key)"],
              ]}
            />
            <Callout type="tip">
              The owner field should be your GitHub username or org name — InariWatch uses it to scope which repos to watch.
            </Callout>

            <SectionHeading id="int-vercel">Integration — Vercel</SectionHeading>
            <P>InariWatch monitors your Vercel deployments and can trigger instant rollbacks on production failures.</P>

            <SubHeading id="int-vercel-token">Getting a token</SubHeading>
            <StepList steps={[
              {
                title: "Open Vercel → Account Settings → Tokens",
                body: <><a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">vercel.com/account/tokens <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Create a token",
                body: <>Give it a name like <InlineCode>inariwatch</InlineCode>. No expiry is easiest for long-term monitoring.</>,
              },
              {
                title: "(Optional) Find your Team ID",
                body: <>Go to your Vercel team → Settings. The team ID is shown as <InlineCode>team_...</InlineCode>. Leave blank if you&apos;re on a personal account.</>,
              },
            ]} />

            <SubHeading id="int-vercel-monitors">What InariWatch monitors</SubHeading>
            <Table
              head={["Alert", "Severity", "Default"]}
              rows={[
                ["Failed production deployment",  "Critical", "On"],
                ["Failed preview deployment",     "Warning",  "Off"],
                ["Instant rollback",              "—",        "On demand"],
              ]}
            />

            <SectionHeading id="int-sentry">Integration — Sentry</SectionHeading>
            <P>InariWatch polls Sentry every 5 minutes for new issues and regressions in your projects.</P>

            <SubHeading id="int-sentry-token">Getting a token</SubHeading>
            <StepList steps={[
              {
                title: "Open Sentry → Settings → Auth Tokens",
                body: <><a href="https://sentry.io/settings/account/api/auth-tokens/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">sentry.io/settings/account/api/auth-tokens <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Create an internal integration token",
                body: (
                  <Table
                    head={["Permission", "Access"]}
                    rows={[
                      ["Issues & Events", "Read"],
                      ["Project",         "Read"],
                      ["Organization",    "Read"],
                    ]}
                  />
                ),
              },
              {
                title: "Find your org slug",
                body: <>It&apos;s in the URL of your Sentry dashboard: <InlineCode>sentry.io/organizations/<strong>my-org</strong>/</InlineCode></>,
              },
            ]} />

            <SubHeading id="int-sentry-monitors">What InariWatch monitors</SubHeading>
            <Table
              head={["Alert", "Severity", "Window"]}
              rows={[
                ["New issue first seen",    "Warning",  "Last 10 min"],
                ["Regression (re-opened)",  "Critical", "Last 10 min"],
              ]}
            />

            <SectionHeading id="int-uptime">Integration — Uptime</SectionHeading>
            <P>
              Uptime monitoring checks your HTTP endpoints at every poll interval and alerts
              if they return a non-2xx status or respond slower than your threshold.
            </P>
            <P>
              In the web dashboard, go to <strong>Integrations → Uptime → Configure</strong> and add your endpoints.
              Each endpoint has a URL and an optional response time threshold in milliseconds.
            </P>
            <Table
              head={["Alert", "Severity"]}
              rows={[
                ["Endpoint returned non-2xx",          "Critical"],
                ["Response time exceeded threshold",   "Warning"],
                ["Endpoint recovered",                 "Info"],
              ]}
            />
            <Callout type="info">
              No token required. InariWatch makes the HTTP requests from its own infrastructure.
            </Callout>

            <SectionHeading id="int-postgres">Integration — PostgreSQL</SectionHeading>
            <P>InariWatch connects to your PostgreSQL database and monitors for health issues without storing your data.</P>
            <P>
              You only need a <strong>read-only connection string</strong>.
              InariWatch runs read-only diagnostic queries — it never writes to your database.
            </P>
            <CodeBlock label="Connection string format">{`postgresql://user:password@host:5432/dbname?sslmode=require`}</CodeBlock>
            <Table
              head={["Alert", "Severity", "Threshold"]}
              rows={[
                ["Connection failure",             "Critical", "Any failure"],
                ["Too many active connections",    "Warning",  "> 80% of max_connections"],
                ["Long-running query",             "Warning",  "> 60 seconds"],
                ["Replication lag",                "Warning",  "> 30 seconds"],
              ]}
            />
            <Callout type="warn">
              Create a dedicated read-only user for InariWatch. Never use a superuser connection string in a third-party service.
            </Callout>
            <CodeBlock label="Create a read-only user (run in psql)">{`CREATE USER inariwatch WITH PASSWORD 'your-password';
GRANT CONNECT ON DATABASE your_db TO inariwatch;
GRANT USAGE ON SCHEMA public TO inariwatch;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO inariwatch;`}</CodeBlock>

            <SectionHeading id="int-npm">Integration — npm / Cargo</SectionHeading>
            <P>
              InariWatch audits your <InlineCode>package.json</InlineCode> or <InlineCode>Cargo.toml</InlineCode> for known vulnerabilities
              using the npm and RustSec advisory databases.
            </P>
            <P>
              Provide a public URL to your manifest file. For private repos, use a raw GitHub URL with a
              Personal Access Token in the request (paste the full URL including auth).
            </P>
            <CodeBlock label="Example public URLs">{`# npm
https://raw.githubusercontent.com/my-org/my-app/main/package.json

# Cargo
https://raw.githubusercontent.com/my-org/my-app/main/Cargo.toml`}</CodeBlock>
            <Table
              head={["Alert", "Severity"]}
              rows={[
                ["Critical CVE found",        "Critical"],
                ["High-severity CVE found",   "Warning"],
                ["Moderate CVE found",        "Info"],
              ]}
            />

            <SectionHeading id="int-datadog">Integration — Datadog</SectionHeading>
            <P>
              InariWatch receives alerts from Datadog monitors via webhooks. When your Datadog monitor
              triggers (log anomaly, infrastructure spike, APM error), InariWatch creates an alert and
              optionally runs AI remediation — bridging the gap between detection and resolution.
            </P>

            <SubHeading id="int-datadog-keys">Getting your keys</SubHeading>
            <StepList steps={[
              {
                title: "Open Datadog → Organization Settings → API Keys",
                body: <><a href="https://app.datadoghq.com/organization-settings/api-keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">app.datadoghq.com/organization-settings/api-keys <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Copy your API Key",
                body: "This is your organization's API key. It starts with a hex string.",
              },
              {
                title: "Create an Application Key",
                body: <>Go to <strong>Application Keys</strong> tab and create a new key. Give it a name like <InlineCode>inariwatch</InlineCode>. Copy the key — it's only shown once.</>,
              },
              {
                title: "Connect in InariWatch",
                body: "Go to Integrations → Datadog → Connect. Paste both keys. InariWatch validates your API key automatically.",
              },
            ]} />

            <SubHeading id="int-datadog-webhook">Setting up the webhook</SubHeading>
            <P>
              After connecting, InariWatch generates a unique <strong>Webhook URL</strong> for your project.
              You need to configure this URL in Datadog so monitors can send alerts to InariWatch.
            </P>
            <StepList steps={[
              {
                title: "Copy the Webhook URL from InariWatch",
                body: "It's shown under the Datadog integration card after connecting. Looks like: https://app.inariwatch.com/api/webhooks/datadog/your-integration-id",
              },
              {
                title: "Open Datadog → Integrations → Webhooks",
                body: <><a href="https://app.datadoghq.com/integrations/webhooks" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">app.datadoghq.com/integrations/webhooks <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Create a new webhook",
                body: <>Name it <InlineCode>inariwatch</InlineCode>, paste the Webhook URL, and leave the payload as the default JSON. Click Save.</>,
              },
              {
                title: "Add the webhook to your monitors",
                body: <>Edit any Datadog monitor → <strong>Notify your team</strong> section → type <InlineCode>@webhook-inariwatch</InlineCode>. Now that monitor will alert InariWatch when it fires.</>,
              },
            ]} />

            <SubHeading id="int-datadog-alerts">What InariWatch receives</SubHeading>
            <Table
              head={["Datadog Event", "InariWatch Severity"]}
              rows={[
                ["Monitor status: Alert / Error",  "Critical"],
                ["Monitor status: Warn",           "Warning"],
                ["Monitor status: Recovered / OK", "Skipped (auto-resolved)"],
              ]}
            />
            <Callout type="tip">
              Datadog sends a &quot;Recovered&quot; event when a monitor goes back to OK. InariWatch automatically
              ignores these so you don&apos;t get noise from self-healing issues.
            </Callout>

            <SectionHeading id="int-capture">Integration — @inariwatch/capture</SectionHeading>
            <P>
              The <InlineCode>@inariwatch/capture</InlineCode> SDK lets you send errors, logs, and deploy markers
              directly from your own application to InariWatch — no third-party error tracker needed.
              It works alongside your existing integrations (Sentry, Datadog) or as a standalone lightweight alternative.
            </P>

            <SubHeading id="int-capture-install">Installation</SubHeading>
            <CodeBlock label="npm">{`npm install @inariwatch/capture`}</CodeBlock>

            <SubHeading id="int-capture-setup">Setup</SubHeading>
            <CodeBlock label="app.ts">{`import { init, captureException, captureLog, captureMessage } from "@inariwatch/capture";

init({
  dsn: "https://app.inariwatch.com/api/webhooks/capture/YOUR_PROJECT_ID",
  environment: "production",
  release: "1.2.0",
});`}</CodeBlock>
            <P>
              The DSN is your project&apos;s capture webhook URL. Find it under <strong>Integrations &rarr; Capture SDK</strong>
              in the web dashboard, or construct it manually: <InlineCode>{'https://app.inariwatch.com/api/webhooks/capture/<project-id>'}</InlineCode>.
            </P>

            <SubHeading id="int-capture-api">API</SubHeading>
            <Table
              head={["Function", "Purpose", "Example"]}
              rows={[
                ["captureException(error)", "Capture a caught exception with full stack trace", "captureException(err)"],
                ["captureLog(level, message, meta?)", "Send a structured log event", "captureLog(\"error\", \"DB timeout\", { query })"],
                ["captureMessage(message, level?)", "Send a plain text event", "captureMessage(\"Deploy started\", \"info\")"],
              ]}
            />
            <CodeBlock label="Example: Express error handler">{`app.use((err, req, res, next) => {
  captureException(err);
  res.status(500).json({ error: "Internal server error" });
});`}</CodeBlock>
            <CodeBlock label="Example: Deploy marker">{`captureMessage("Deploy v1.2.0 started", "info");`}</CodeBlock>
            <Callout type="tip">
              The SDK batches events and flushes on a short interval. In serverless environments,
              call <InlineCode>await flush()</InlineCode> before the function returns to ensure events are sent.
            </Callout>
            <Callout type="info">
              When running locally, the SDK auto-detects <InlineCode>localhost</InlineCode> DSNs and routes events
              to the CLI capture server (<InlineCode>inariwatch watch</InlineCode>) instead of the cloud.
            </Callout>

            {/* ────────────────────────────────────────────────────────────────
                AI SETUP
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="ai-overview">AI setup — Overview (BYOK)</SectionHeading>
            <P>
              InariWatch uses a <strong>Bring Your Own Key</strong> model. Your API key goes directly
              from your browser to your AI provider — InariWatch never stores or proxies it (except
              for saving the key reference in your account so you don&apos;t have to re-enter it).
            </P>
            <P>
              Adding an AI key unlocks:
            </P>
            <ul className="mb-4 space-y-1.5 text-sm text-fg-base">
              {[
                "AI root cause analysis on any alert",
                "AI code remediation — writes the fix, pushes a branch, waits for CI, opens a PR",
                "Pre-deploy PR risk scoring (GitHub integration required)",
                "Auto post-mortems when an incident is resolved",
                "Alert correlation — groups related alerts into one incident",
                "Ask Inari — chat with your live monitoring data",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
                  {f}
                </li>
              ))}
            </ul>
            <Callout type="tip">
              You can add multiple providers. InariWatch uses whichever key you set as primary, with Claude preferred by default if present.
            </Callout>

            <SectionHeading id="ai-claude">AI — Claude (Anthropic)</SectionHeading>
            <P>Claude is the recommended provider — InariWatch&apos;s AI features are tuned for Claude&apos;s output style.</P>
            <StepList steps={[
              {
                title: "Create an API key",
                body: <><a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">console.anthropic.com/settings/keys <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Copy the key",
                body: <>Starts with <InlineCode>sk-ant-api03-...</InlineCode></>,
              },
              {
                title: "Paste into InariWatch",
                body: <>Settings → AI analysis → Add key → Select Claude.</>,
              },
            ]} />
            <Table
              head={["Model", "Context", "Best for"]}
              rows={[
                ["claude-sonnet-4-5 (recommended)", "200k", "Remediation, correlation, analysis"],
                ["claude-haiku-4-5",                "200k", "Fast analysis, lower cost"],
                ["claude-opus-4-5",                 "200k", "Complex repos, maximum quality"],
              ]}
            />
            <CodeBlock label="CLI">{`inariwatch config --ai-key sk-ant-api03-... --model claude-sonnet-4-5-20251022`}</CodeBlock>

            <SectionHeading id="ai-openai">AI — OpenAI</SectionHeading>
            <StepList steps={[
              {
                title: "Create an API key",
                body: <><a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">platform.openai.com/api-keys <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Copy the key",
                body: <>Starts with <InlineCode>sk-proj-...</InlineCode> (new format) or <InlineCode>sk-...</InlineCode> (legacy).</>,
              },
              { title: "Paste into InariWatch", body: "Settings → AI analysis → Add key → Select OpenAI." },
            ]} />
            <Table
              head={["Model", "Best for"]}
              rows={[
                ["gpt-4o (recommended)", "Balanced quality and speed"],
                ["gpt-4o-mini",          "Lower cost, faster responses"],
                ["o1-mini",              "Complex reasoning tasks"],
              ]}
            />
            <CodeBlock label="CLI">{`inariwatch config --ai-key sk-proj-... --model gpt-4o`}</CodeBlock>

            <SectionHeading id="ai-grok">AI — Grok (xAI)</SectionHeading>
            <StepList steps={[
              {
                title: "Create an API key",
                body: <><a href="https://console.x.ai" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">console.x.ai <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Copy the key",
                body: <>Starts with <InlineCode>xai-...</InlineCode></>,
              },
              { title: "Paste into InariWatch", body: "Settings → AI analysis → Add key → Select Grok." },
            ]} />
            <CodeBlock label="CLI">{`inariwatch config --ai-key xai-... --model grok-beta`}</CodeBlock>

            <SectionHeading id="ai-deepseek">AI — DeepSeek</SectionHeading>
            <StepList steps={[
              {
                title: "Create an API key",
                body: <><a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">platform.deepseek.com/api_keys <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Copy the key",
                body: <>Starts with <InlineCode>sk-...</InlineCode></>,
              },
              { title: "Paste into InariWatch", body: "Settings → AI analysis → Add key → Select DeepSeek." },
            ]} />
            <CodeBlock label="CLI">{`inariwatch config --ai-key sk-... --model deepseek-chat`}</CodeBlock>

            <SectionHeading id="ai-gemini">AI — Gemini (Google)</SectionHeading>
            <StepList steps={[
              {
                title: "Create an API key",
                body: <><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">aistudio.google.com/app/apikey <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Copy the key",
                body: <>Starts with <InlineCode>AIza...</InlineCode></>,
              },
              { title: "Paste into InariWatch", body: "Settings → AI analysis → Add key → Select Gemini." },
            ]} />
            <CodeBlock label="CLI">{`inariwatch config --ai-key AIza... --model gemini-2.0-flash`}</CodeBlock>

            {/* ────────────────────────────────────────────────────────────────
                NOTIFICATIONS
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="notif-telegram">Notifications — Telegram</SectionHeading>
            <P>
              Telegram is supported in both the CLI and the web dashboard.
              It&apos;s the fastest setup — no server, no webhook config.
            </P>
            <StepList steps={[
              {
                title: "Create a Telegram bot",
                body: <>Open Telegram → search <strong>@BotFather</strong> → send <InlineCode>/newbot</InlineCode>. Copy the token it gives you.</>,
              },
              {
                title: "Find your chat ID",
                body: <>Send a message to your bot, then open: <InlineCode>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</InlineCode>. The <InlineCode>chat.id</InlineCode> field is your ID.</>,
              },
              {
                title: "Connect in InariWatch",
                body: "Web: Settings → Notification channels → Telegram. CLI: inariwatch connect telegram.",
              },
            ]} />
            <CodeBlock label="CLI shortcut">{`inariwatch connect telegram
# Prompts for bot token and chat ID`}</CodeBlock>

            <SectionHeading id="notif-email">Notifications — Email</SectionHeading>
            <P>
              Email delivery is handled by InariWatch — you just provide your address.
              Critical alerts are sent immediately; warning and info alerts are batched into a daily digest.
            </P>
            <StepList steps={[
              { title: "Go to Settings → Notification channels → Email", body: "Enter your email address and click Send verification." },
              { title: "Verify your address", body: "Click the link in the verification email. Alerts won't send until verified." },
              { title: "Set minimum severity (optional)", body: "You can filter to Critical only to reduce noise." },
            ]} />
            <Callout type="info">
              To keep InariWatch free and respect email limits, non-critical alerts are batched into daily/weekly digests. Only Critical alerts are sent immediately.
            </Callout>

            <SectionHeading id="notif-slack">Notifications — Slack</SectionHeading>
            <StepList steps={[
              {
                title: "Create an Incoming Webhook in Slack",
                body: <><a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">api.slack.com/apps <ExternalLink className="h-3 w-3" /></a> → Create App → From scratch → Incoming Webhooks → Add new webhook to workspace.</>,
              },
              {
                title: "Select a channel",
                body: <>Choose the channel where alerts should appear (e.g. <InlineCode>#incidents</InlineCode>). Copy the webhook URL.</>,
              },
              {
                title: "Paste into InariWatch",
                body: "Settings → Notification channels → Slack → paste the webhook URL.",
              },
            ]} />

            <SectionHeading id="notif-push">Notifications — Push (browser)</SectionHeading>
            <P>
              Browser push sends OS-level notifications to your desktop or mobile browser — no app needed.
            </P>
            <StepList steps={[
              { title: "Go to Settings → Notification channels → Push", body: "Click Enable push notifications." },
              { title: "Allow browser permissions", body: "Your browser will prompt to allow notifications. Click Allow." },
              { title: "Done", body: "InariWatch will send a test notification immediately to confirm it works." },
            ]} />
            <Callout type="warn">
              Push notifications only work while your browser has been opened at least once since registration.
              For 24/7 coverage, use Telegram or email.
            </Callout>

            <SectionHeading id="notif-oncall">Notifications — On-Call Schedules</SectionHeading>
            <P>
              InariWatch allows you to configure timezone-aware daily on-call rotations for your team.
              Instead of paging the entire team with critical alerts, Escalation Rules can dynamically
              route the notification to the specific developer currently on-call.
            </P>
            <StepList steps={[
              { title: "Go to your Project → On-Call Schedule", body: "Click Add schedule and set your project's timezone." },
              { title: "Add members to slots", body: "Select a user and choose their day and hour ranges (e.g. Mon-Fri, 09:00-17:00)." },
              { title: "Enable in Escalation Rules", body: "Escalation rules will automatically use the on-call schedule before falling back to fixed channels." },
            ]} />
            <Callout type="info">
              A green badge will appear in the dashboard indicating exactly who is currently on-call based on the active slots.
            </Callout>

            <SectionHeading id="notif-overrides">Notifications — Schedule Overrides</SectionHeading>
            <P>
              Schedule Overrides let you temporarily replace the on-call person without modifying
              the base rotation. Perfect for sick days, vacations, or emergencies.
            </P>
            <StepList steps={[
              { title: "Go to your Project → On-Call Schedule", body: "Find the schedule you want to override." },
              { title: "Click 'Add Override'", body: "Select the substitute user and choose a start and end date/time." },
              { title: "Done", body: "During the override window, the substitute receives all escalation notifications instead of the original on-call person." },
            ]} />
            <Callout type="tip">
              Overrides take priority over regular slots. Once the override window expires, the schedule automatically falls back to the base rotation — no cleanup needed.
            </Callout>

            <SectionHeading id="notif-storm">Notifications — Incident Storm Control</SectionHeading>
            <P>
              When a major infrastructure failure occurs (e.g. database crash), dozens of monitors
              can trigger simultaneously. Without grouping, the on-call engineer gets 50 notifications
              in seconds — causing alert fatigue and panic.
            </P>
            <P>
              <strong>Incident Storm Control</strong> detects when more than 5 alerts arrive for the same
              project within a 5-minute window. Instead of sending individual notifications, InariWatch
              groups them into a single &quot;Incident Storm&quot; message:
            </P>
            <CodeBlock label="Example Storm Notification">{`🚨 [INCIDENT STORM] 14 alerts detected in 5 min
Project: my-production-app

Likely a cascading failure.
Resolve the root cause — all grouped alerts will clear together.`}</CodeBlock>
            <Callout type="info">
              Storm detection is fully automatic — no configuration needed. All alerts within a storm are linked to the same incident ID for post-mortem analysis.
            </Callout>

            <SectionHeading id="notif-ack">Notifications — Interactive ACK</SectionHeading>
            <P>
              When InariWatch sends a critical alert to Telegram, the message includes interactive
              inline buttons that let you take action directly from your phone:
            </P>
            <ul className="mb-4 space-y-1.5 text-sm text-fg-base">
              {[
                "👁️ Acknowledge — Stops the escalation timer. Your team knows you're looking at it.",
                "✅ Resolve — Marks the alert as resolved. No more follow-up notifications.",
                "🔇 Snooze 30m — Silences the alert for 30 minutes, then re-alerts if still unresolved.",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
                  {f}
                </li>
              ))}
            </ul>
            <Callout type="tip">
              No need to open your laptop at 3 AM. Tap the button in Telegram from your bed and the escalation engine respects your acknowledgment instantly.
            </Callout>

            {/* ────────────────────────────────────────────────────────────────
                DESKTOP APP
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="desktop-setup">Desktop app — Setup & token</SectionHeading>
            <P>
              The InariWatch desktop app is a lightweight tray app that polls your account
              in the background and shows OS notifications — even when you&apos;re not in the browser.
            </P>
            <StepList steps={[
              {
                title: "Download the desktop app",
                body: <>Download the installer for your OS from the <a href="https://github.com/orbita-pos/inariwatch/releases" target="_blank" rel="noreferrer" className="text-inari-accent underline underline-offset-2">releases page</a>. Supports macOS, Windows, and Linux.</>,
              },
              {
                title: "Generate a desktop token",
                body: <>Go to <strong>Settings → Desktop app → Generate token</strong>. This creates a token starting with <InlineCode>rdr_...</InlineCode>.</>,
              },
              {
                title: "Add the token to the config file",
                body: <>Create or edit <InlineCode>~/.config/inari/desktop.toml</InlineCode> with the values below.</>,
              },
              {
                title: "Start the app",
                body: "The tray icon appears (◉). Alerts will show as OS notifications. Click the icon to open the dashboard.",
              },
            ]} />
            <Callout type="info">The desktop app is completely free, just generate a token to connect it.</Callout>

            <SectionHeading id="desktop-config">Desktop app — desktop.toml</SectionHeading>
            <CodeBlock label="~/.config/inari/desktop.toml">{`api_url   = "https://inariwatch.com"
api_token = "rdr_your_token_here"`}</CodeBlock>
            <P>
              The app polls <InlineCode>/api/desktop/alerts</InlineCode> every 60 seconds using this token.
              Alerts are shown as OS notifications and marked as read in the dashboard.
            </P>

            {/* ────────────────────────────────────────────────────────────────
                REFERENCE
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="ref-alerts">Reference — Alert types & severity</SectionHeading>
            <Table
              head={["Severity", "Color", "Meaning"]}
              rows={[
                ["Critical", "Red",    "Immediate action required — production is affected"],
                ["Warning",  "Amber",  "Degraded state — action recommended soon"],
                ["Info",     "Blue",   "Informational — no immediate action needed"],
              ]}
            />
            <SubHeading id="ref-alerts-dedup">Deduplication</SubHeading>
            <P>
              Before creating a new alert, InariWatch checks whether an open, unresolved alert
              with the same title already exists for the same project within the last 24 hours.
              If one does, the new alert is silently dropped — you won&apos;t get spammed by the same event.
            </P>
            <P>
              To force a new alert (e.g. after resolving), mark the existing alert as Resolved first.
            </P>

            <SectionHeading id="ref-api">Reference — REST API</SectionHeading>
            <P>
              InariWatch exposes one public REST endpoint — used by the desktop app and any custom tooling.
            </P>

            <SubHeading id="ref-api-alerts">GET /api/desktop/alerts</SubHeading>
            <P>Returns the most recent unread alerts for the authenticated user.</P>
            <CodeBlock label="Request">{`GET /api/desktop/alerts
Authorization: Bearer rdr_your_token_here`}</CodeBlock>
            <CodeBlock label="Response (200)">{`{
  "alerts": [
    {
      "id":          "uuid",
      "title":       "CI failing on main",
      "severity":    "critical",
      "isResolved":  false,
      "createdAt":   "2025-03-17T03:12:00Z",
      "sourceIntegrations": ["github"]
    }
  ]
}`}</CodeBlock>
            <Table
              head={["Status", "Meaning"]}
              rows={[
                ["200", "Success"],
                ["401", "Missing or invalid token"],
                ["403", "Token exists but account is not Pro"],
              ]}
            />

            {/* Bottom nav */}
            <div className="mt-16 flex items-center justify-between border-t border-line pt-8 text-sm text-zinc-500">
              <Link href="/" className="flex items-center gap-1.5 hover:text-fg-base transition-colors">
                <ChevronRight className="h-3.5 w-3.5 rotate-180" />
                Home
              </Link>
              <Link href="/register" className="flex items-center gap-1.5 text-inari-accent hover:text-inari-accent/80 transition-colors">
                Start free
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>

          </main>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-inari-border py-8 mt-4">
        <div className="mx-auto max-w-6xl px-6 flex flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2.5">
            <Image src="/logo-inari/favicon-96x96.png" alt="InariWatch" width={24} height={24} />
            <span className="font-mono text-fg-base uppercase tracking-widest text-xs font-semibold">INARIWATCH</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-zinc-500">
            <Link href="/"        className="hover:text-fg-base transition-colors">Home</Link>
            <a href="https://github.com/sponsors/orbita-pos" target="_blank" rel="noreferrer" className="hover:text-fg-base transition-colors">Sponsor</a>
            <Link href="/docs"    className="hover:text-fg-base transition-colors">Docs</Link>
            <a href="https://github.com/orbita-pos/inariwatch" target="_blank" rel="noreferrer" className="hover:text-fg-base transition-colors">GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
