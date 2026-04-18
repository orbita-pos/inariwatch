import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { CopyButton } from "../copy-button";
import { MarketingNav } from "../marketing-nav";
import { DocsSidebar } from "./docs-sidebar";
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

const PAGE_TITLE       = "Docs — InariWatch";
const PAGE_DESCRIPTION = "Documentation for InariWatch — CLI, integrations, AI providers, MCP server, Slack and Telegram bots, and the web dashboard.";
const PAGE_URL         = "https://inariwatch.com/docs";

export const metadata: Metadata = {
  title:       PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates:  { canonical: PAGE_URL },
  openGraph: {
    type:        "website",
    url:         PAGE_URL,
    siteName:    "InariWatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    // images auto-resolved from app/opengraph-image.tsx
  },
  twitter: {
    card:        "summary_large_image",
    site:        "@inariwatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
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
      { id: "cli-mcp",        label: "MCP Server (deprecated)" },
      { id: "cli-rollback",   label: "Rollback" },
      { id: "cli-dev",        label: "Dev Mode" },
      { id: "cli-cron",       label: "Cron Scheduler" },
    ],
  },
  {
    group: "Integrations",
    items: [
      { id: "int-github",    label: "GitHub" },
      { id: "int-vercel",    label: "Vercel" },
      { id: "int-netlify",   label: "Netlify" },
      { id: "int-cloudflare-pages", label: "Cloudflare Pages" },
      { id: "int-render",    label: "Render" },
      { id: "int-sentry",    label: "Sentry" },
      { id: "int-datadog",   label: "Datadog" },
      { id: "int-expo",      label: "Expo" },
      { id: "int-uptime",    label: "Uptime" },
      { id: "int-postgres",  label: "PostgreSQL" },
      { id: "int-npm",       label: "npm / Cargo" },
      { id: "int-capture",   label: "@inariwatch/capture" },
      { id: "int-shield",    label: "Shield (runtime security)" },
      { id: "int-agent",     label: "InariWatch Agent (kernel-level)" },
    ],
  },
  {
    group: "AI setup",
    items: [
      { id: "ai-overview",   label: "Overview (Free + BYOK)" },
      { id: "ai-claude",     label: "Claude (Anthropic)" },
      { id: "ai-openai",     label: "OpenAI" },
      { id: "ai-grok",       label: "Grok (xAI)" },
      { id: "ai-groq",       label: "Groq (Llama)" },
      { id: "ai-deepseek",   label: "DeepSeek" },
      { id: "ai-gemini",     label: "Gemini (Google)" },
    ],
  },
  {
    group: "Autonomous Mode",
    items: [
      { id: "auto-remediate",  label: "Auto-Remediate" },
      { id: "auto-heal",       label: "Auto-Heal" },
      { id: "staging-env",     label: "Staging Env Vars" },
      { id: "preview-fix",     label: "Preview Fix" },
      { id: "community-fixes", label: "Community Fixes" },
    ],
  },
  {
    group: "Slack Bot",
    items: [
      { id: "slack-setup",     label: "Setup" },
      { id: "slack-commands",  label: "Commands (14)" },
      { id: "slack-actions",   label: "Button actions (10)" },
      { id: "slack-fix",       label: "Fix from Slack" },
      { id: "slack-ai",        label: "Ask Inari" },
      { id: "slack-oncall",    label: "On-Call in Slack" },
      { id: "slack-deploys",   label: "Deploy Monitoring" },
    ],
  },
  {
    group: "Telegram Bot",
    items: [
      { id: "telegram-setup",    label: "Setup" },
      { id: "telegram-commands", label: "Commands (15)" },
      { id: "telegram-actions",  label: "Button actions (10)" },
      { id: "telegram-auto",     label: "Auto-delivery" },
    ],
  },
  {
    group: "InariWatch Bot (Mobile)",
    items: [
      { id: "bot-overview",  label: "Overview" },
      { id: "bot-install",   label: "Install" },
      { id: "bot-screens",   label: "Screens" },
      { id: "bot-push",      label: "Push Notifications" },
    ],
  },
  {
    group: "VS Code Extension",
    items: [
      { id: "vscode-setup",    label: "Setup" },
      { id: "vscode-features", label: "Features" },
      { id: "vscode-local",    label: "Local Mode" },
    ],
  },
  {
    group: "Notifications",
    items: [
      { id: "notif-telegram", label: "Telegram" },
      { id: "notif-email",    label: "Email" },
      { id: "notif-slack",    label: "Slack (webhook)" },
      { id: "notif-push",     label: "Push (browser)" },
      { id: "notif-oncall",   label: "On-Call Schedules" },
      { id: "notif-overrides", label: "Schedule Overrides" },
      { id: "notif-storm",    label: "Incident Storm Control" },
      { id: "notif-ack",      label: "Interactive ACK" },
      { id: "notif-digest",   label: "Weekly Digest" },
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
    group: "Analytics",
    items: [
      { id: "analytics-overview", label: "Overview" },
      { id: "analytics-mttr",     label: "MTTR comparison" },
      { id: "analytics-roi",      label: "Cost savings" },
      { id: "analytics-ai",       label: "AI Remediation stats" },
    ],
  },
  {
    group: "Code Intelligence",
    items: [
      { id: "code-intel-overview",   label: "Overview" },
      { id: "code-intel-indexing",   label: "Codebase Indexing" },
      { id: "code-intel-search",     label: "Hybrid Search" },
      { id: "code-intel-embeddings", label: "Embeddings (Voyage Code 3)" },
      { id: "code-intel-tree-sitter", label: "AST Parsing (Tree-sitter)" },
      { id: "code-intel-fix-replay", label: "Fix Replay" },
      { id: "code-intel-test-gen",   label: "Regression Test Generation" },
      { id: "code-intel-substrate-replay", label: "Substrate Replay" },
      { id: "code-intel-e2e",        label: "E2E Staging Verification" },
      { id: "code-intel-gates",      label: "Safety Gates (11)" },
    ],
  },
  {
    group: "Session Replay",
    items: [
      { id: "replay-overview",     label: "Overview" },
      { id: "replay-install",      label: "Install SDK" },
      { id: "replay-user",         label: "Identify the user" },
      { id: "replay-privacy",      label: "Privacy & PII masking" },
      { id: "replay-vitals",       label: "Web Vitals" },
      { id: "replay-frustration",  label: "Rage + dead clicks" },
      { id: "replay-generate-fix", label: "Generate Fix from a replay" },
      { id: "replay-settings",     label: "Per-project settings" },
      { id: "replay-retention",    label: "Retention" },
    ],
  },
  {
    group: "MCP Server",
    items: [
      { id: "mcp-overview",   label: "Overview" },
      { id: "mcp-setup",      label: "Setup" },
      { id: "mcp-tools",      label: "Tools (25)" },
      { id: "mcp-resources",  label: "Resources (4)" },
      { id: "mcp-prompts",    label: "Prompts (7)" },
      { id: "mcp-auth",       label: "Auth & scopes" },
    ],
  },
  {
    group: "Public APIs",
    items: [
      { id: "api-fix-marketplace", label: "Fix Marketplace" },
      { id: "api-status-widget",   label: "Status Widget" },
    ],
  },
  {
    group: "Reference",
    items: [
      { id: "ref-alerts",       label: "Alert types & severity" },
      { id: "ref-api",          label: "REST API" },
      { id: "ref-stress-tests", label: "Stress testing" },
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
    <div className="my-4 overflow-hidden rounded-lg border border-line bg-surface-inner">
      {label && (
        <div className="border-b border-line px-4 py-2 flex items-center justify-between">
          <span className="font-mono text-[11px] text-fg-base/70 uppercase tracking-wider">{label}</span>
          <CopyButton text={children.trim()} />
        </div>
      )}
      <pre className="overflow-x-auto p-4 font-mono text-sm text-fg-strong leading-6 whitespace-pre">{children.trim()}</pre>
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-surface-inner border border-line-subtle px-1.5 py-0.5 font-mono text-xs text-fg-strong">
      {children}
    </code>
  );
}

function Callout({ type = "info", children }: { type?: "info" | "warn" | "tip"; children: React.ReactNode }) {
  const styles = {
    info: "border-blue-300 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-950/20 text-blue-700 dark:text-blue-300",
    warn: "border-amber-300 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-300",
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
              <th key={h} className="px-4 py-2.5 text-left font-medium text-fg-base/70 text-xs uppercase tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-subtle">
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? "bg-surface" : "bg-surface-inner/40"}>
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2.5 text-fg-base font-mono text-xs">
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
          background: rgba(234,88,12,0.25);
          border-radius: 9999px;
          transition: background 0.2s;
        }
        .docs-sidebar:hover::-webkit-scrollbar-thumb { background: rgba(234,88,12,0.55); }
        .docs-sidebar { scrollbar-width: thin; scrollbar-color: rgba(234,88,12,0.25) transparent; }
      `}</style>
      <MarketingNav opaque />

      <div className="mx-auto max-w-6xl px-6 pt-20">
        <div className="flex gap-10 lg:gap-16">

          {/* ── Sidebar (scrollspy-aware) ──────────────────────────────────── */}
          <DocsSidebar nav={NAV} />

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
                title: "(Optional) Add your own AI key for auto-fix",
                body: <>AI analysis works out of the box. To unlock code remediation, chat, and post-mortems, go to <strong>Settings → AI analysis</strong> and add your key. See <a href="#ai-overview" className="text-inari-accent underline underline-offset-2">AI setup</a> for supported providers.</>,
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
                ["inariwatch config --ai-key <key>",        "Set AI key (Claude, OpenAI, Groq, Grok, DeepSeek, or Gemini)"],
                ["inariwatch config --model <model>",       "Set the AI model"],
                ["inariwatch config --auto-fix true",       "Enable autonomous AI fix pipeline on critical alerts"],
                ["inariwatch config --auto-merge true",     "Auto-merge generated PRs when all safety gates pass"],
                ["inariwatch config --show",                "Print current config (keys masked)"],
                ["inariwatch daemon install",               "Register InariWatch as a background service (systemd / launchd / Task Scheduler)"],
                ["inariwatch daemon start|stop|status",     "Control the background daemon"],
                ["inariwatch daemon uninstall",             "Remove the background service"],
                ["inariwatch agent-stats",                  "Show AI agent track record, trust level, and auto-merge gates"],
                ["inariwatch rollback vercel",              "Interactive rollback — pick a previous deployment to restore"],
                ["inariwatch dev",                          "Local dev mode — catch errors, diagnose with AI, apply fixes to local files"],
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
              Even then, a PR is only merged when <strong>all 11 safety gates pass</strong>: auto-merge enabled, CI green, confidence ≥ threshold,
              self-review score ≥ 70, lines changed ≤ max, Substrate risk ≤ 40, EAP chain verified, prediction safe, security scan clean, Substrate replay pass, and staging E2E pass.
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
                CLI MCP SERVER — deprecated, redirect to hosted
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="cli-mcp">CLI — MCP Server</SectionHeading>
            <Callout type="warn">
              The local <InlineCode>inariwatch serve-mcp</InlineCode> command has been <strong>deprecated</strong>. Use the hosted MCP server at{" "}
              <InlineCode>mcp.inariwatch.com</InlineCode> instead — it has the full 25-tool surface, OAuth, and works with any MCP-compatible client without running a local process.
            </Callout>
            <P>
              See the <a href="#mcp-overview" className="text-inari-accent underline underline-offset-2">MCP Server section below</a> for setup instructions and the full tool catalog.
              The fastest path is <InlineCode>npx @inariwatch/mcp init</InlineCode> — it auto-detects Claude Code, Cursor, Windsurf, VS Code Copilot, Codex CLI, Gemini CLI, and OpenClaw, and wires them up in one command.
            </P>

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
                CLI DEV MODE
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="cli-dev">CLI — Dev Mode</SectionHeading>
            <P>
              <InlineCode>inariwatch dev</InlineCode> is a local development companion. It catches errors from your dev server
              via the capture SDK, diagnoses them with AI, and applies fixes directly to your local files — no GitHub, no PR, no branch.
            </P>
            <CodeBlock label="Terminal">{`inariwatch dev

◉ INARIWATCH DEV

◉ Dev mode — my-app | Capture :9111 | Ctrl+C to stop
→ Errors from your dev server will be diagnosed and fixed locally.

  🔴 TypeError: Cannot read 'user' of undefined
     auth/session.ts:84
     💡 Known pattern (confidence: 92%) — add null check
     → Scanning project files... 142 files
     → Diagnosing... 92% confidence
     → Read 1 file(s): auth/session.ts
     → Generating fix... done
     → Self-reviewing... 88/100 (approve)

     Fix: session.user?.id ?? null

     Apply fix? yes
     ✓ Saved auth/session.ts
     ✓ Fix applied. Memory saved.`}</CodeBlock>
            <P>
              <strong>How it works:</strong> the capture server listens on <InlineCode>localhost:9111</InlineCode> for errors from <InlineCode>@inariwatch/capture</InlineCode>.
              When an error arrives, InariWatch reads your local source files, generates a fix with AI, runs a self-review, and shows you the diff.
              You confirm with <InlineCode>y</InlineCode> and the fix is applied directly to disk.
            </P>
            <P>
              <strong>Dev trains prod:</strong> every fix you apply locally is saved to the incident memory.
              When the same error appears in production, InariWatch already knows the pattern — resulting in higher confidence and faster auto-fix.
            </P>
            <Table
              head={["Flag", "Description"]}
              rows={[
                ["--project <name>", "Select which project to use (auto-detected if only one)"],
                ["--port <port>",    "Override capture server port (default: 9111)"],
              ]}
            />
            <Callout type="info">
              Dev mode requires an AI key (<InlineCode>inariwatch config --ai-key</InlineCode>).
              It does NOT require GitHub — everything runs locally.
              Your code never leaves your machine.
            </Callout>
            <Callout type="tip">
              Run <InlineCode>inariwatch dev</InlineCode> alongside <InlineCode>npm run dev</InlineCode> or any local dev server
              that uses <InlineCode>@inariwatch/capture</InlineCode>. Errors are caught the instant they happen.
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
            <Callout type="info">
              Vercel is one of <strong>four supported hosting providers</strong>. Every feature below —
              webhook receiver, auto-rollback, auto-heal, deploy notifications, 15-min health check,
              dashboard rollback button, Slack <InlineCode>/rollback</InlineCode>, MCP <InlineCode>rollback_deploy</InlineCode>,
              and AI diagnosis with build logs — works identically on <a href="#int-netlify" className="text-inari-accent underline underline-offset-2">Netlify</a>,
              {" "}<a href="#int-cloudflare-pages" className="text-inari-accent underline underline-offset-2">Cloudflare Pages</a>, and
              {" "}<a href="#int-render" className="text-inari-accent underline underline-offset-2">Render</a>.
            </Callout>

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

            <SectionHeading id="int-netlify">Integration — Netlify</SectionHeading>
            <P>
              InariWatch receives webhooks from Netlify for failed deploys, alerts you, and can roll back
              to the last successful deploy — same UX as Vercel, just a different host.
            </P>

            <SubHeading id="int-netlify-token">Getting a token</SubHeading>
            <StepList steps={[
              {
                title: "Open Netlify → User settings → Applications",
                body: <><a href="https://app.netlify.com/user/applications/personal" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">app.netlify.com/user/applications/personal <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Create a Personal Access Token",
                body: <>Give it a name like <InlineCode>inariwatch</InlineCode>. The token needs <strong>Deploys: Read/Write</strong> and <strong>Sites: Read</strong>.</>,
              },
              {
                title: "Find your Site ID",
                body: <>Go to your site → <strong>Site settings → General → Site information</strong>. The Site ID looks like <InlineCode>12345678-abcd-efgh-ijkl-mnopqrstuvwx</InlineCode>.</>,
              },
              {
                title: "Connect in InariWatch",
                body: <>Integrations → <strong>Connect Netlify</strong> → paste token + Site ID. InariWatch validates the token and registers a webhook automatically.</>,
              },
            ]} />

            <SubHeading id="int-netlify-monitors">What InariWatch monitors</SubHeading>
            <Table
              head={["Alert", "Severity", "Default"]}
              rows={[
                ["Failed production deploy",    "Critical", "On"],
                ["Failed deploy-preview",       "Warning",  "Off"],
                ["Build logs in AI diagnosis",  "—",        "On (via Netlify log API)"],
                ["Instant rollback (API + UI)", "—",        "On demand"],
                ["Auto-rollback on webhook",    "—",        "On (when autoRollback enabled)"],
                ["Auto-heal on uptime down",    "—",        "On (when autoHeal enabled)"],
              ]}
            />

            <SectionHeading id="int-cloudflare-pages">Integration — Cloudflare Pages</SectionHeading>
            <P>
              Full parity with Vercel and Netlify: deploy alerts, one-click rollback, auto-heal, and
              AI diagnosis enriched with Cloudflare build logs.
            </P>

            <SubHeading id="int-cf-token">Getting a token</SubHeading>
            <StepList steps={[
              {
                title: "Open Cloudflare → My Profile → API Tokens",
                body: <><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">dash.cloudflare.com/profile/api-tokens <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Create a Custom Token",
                body: (
                  <Table
                    head={["Permission", "Access"]}
                    rows={[
                      ["Account → Cloudflare Pages", "Edit"],
                      ["Account → Account Settings", "Read"],
                    ]}
                  />
                ),
              },
              {
                title: "Find your Account ID",
                body: <>It&apos;s shown in the right sidebar of your Cloudflare dashboard under <strong>Account Details</strong>.</>,
              },
              {
                title: "Connect in InariWatch",
                body: <>Integrations → <strong>Connect Cloudflare Pages</strong> → paste token, Account ID, and Project Name (must match the Pages project slug exactly).</>,
              },
            ]} />

            <SubHeading id="int-cf-monitors">What InariWatch monitors</SubHeading>
            <Table
              head={["Alert", "Severity", "Default"]}
              rows={[
                ["Failed production deployment",   "Critical", "On"],
                ["Failed preview deployment",      "Warning",  "Off"],
                ["Build logs in AI diagnosis",     "—",        "On (via history/logs endpoint)"],
                ["Instant rollback (API + UI)",    "—",        "On demand"],
                ["Auto-rollback on webhook",       "—",        "On (when autoRollback enabled)"],
                ["Auto-heal on uptime down",       "—",        "On (when autoHeal enabled)"],
              ]}
            />

            <SectionHeading id="int-render">Integration — Render</SectionHeading>
            <P>
              Render is fully supported for deploy alerts, rollback, and auto-heal. The only caveat is
              that Render does not expose build logs via its public REST API, so AI diagnosis runs
              without the build output — everything else is identical.
            </P>

            <SubHeading id="int-render-token">Getting a token</SubHeading>
            <StepList steps={[
              {
                title: "Open Render → Account Settings → API Keys",
                body: <><a href="https://dashboard.render.com/account/api-keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">dashboard.render.com/account/api-keys <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Create an API Key",
                body: <>Render API keys have full account access. Store it in a password manager — it&apos;s only shown once.</>,
              },
              {
                title: "Find your Service ID",
                body: <>Open the service in the Render dashboard. The Service ID is in the URL: <InlineCode>dashboard.render.com/web/<strong>srv-abc123...</strong></InlineCode></>,
              },
              {
                title: "Connect in InariWatch",
                body: <>Integrations → <strong>Connect Render</strong> → paste API key, Service ID, and a display name.</>,
              },
            ]} />

            <SubHeading id="int-render-monitors">What InariWatch monitors</SubHeading>
            <Table
              head={["Alert", "Severity", "Default"]}
              rows={[
                ["Failed deploy (build_failed)", "Critical", "On"],
                ["Instant rollback (API + UI)",  "—",        "On demand"],
                ["Auto-rollback on webhook",     "—",        "On (when autoRollback enabled)"],
                ["Auto-heal on uptime down",     "—",        "On (when autoHeal enabled)"],
                ["Build logs in AI diagnosis",   "—",        "Not available (Render has no public log API)"],
              ]}
            />
            <Callout type="info">
              Render logs live in their dashboard and are not exposed via the REST API. AI diagnosis
              still runs — it just uses Sentry, GitHub CI, and Substrate context instead of build output.
            </Callout>

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

            <SectionHeading id="int-expo">Integration — Expo</SectionHeading>
            <P>
              Monitor EAS Build failures and OTA Update rollbacks. InariWatch polls the Expo API
              and receives webhooks for real-time alerts with AI diagnosis.
            </P>

            <SubHeading id="int-expo-setup">Connect Expo</SubHeading>
            <StepList steps={[
              { title: "Create an access token", body: <>Go to <strong>expo.dev/settings/access-tokens</strong> and generate a Personal Access Token with project read access.</> },
              { title: "Connect in InariWatch", body: "Integrations → Connect Expo → Paste your token. InariWatch validates it and detects your username." },
              { title: "Configure alerts", body: "Choose which alerts to enable: build failures, update rollbacks. Both enabled by default." },
            ]} />

            <SubHeading id="int-expo-webhook">Webhook setup (optional)</SubHeading>
            <P>
              For real-time alerts (instead of polling every 5 minutes), set up a webhook in Expo:
            </P>
            <StepList steps={[
              { title: "Copy the webhook URL", body: "After connecting, InariWatch shows a webhook URL and a signing secret." },
              { title: "Add in Expo", body: <>Go to your Expo project → <strong>Settings → Webhooks → Add webhook</strong>. Paste the URL and secret. Select Build and Update events.</> },
            ]} />

            <SubHeading id="int-expo-alerts">What InariWatch monitors</SubHeading>
            <Table
              head={["Alert", "Severity", "Trigger"]}
              rows={[
                ["Build failure", "Critical", "EAS Build status = errored or canceled"],
                ["Update rollback", "Warning", "EAS OTA Update rolled back to embedded"],
              ]}
            />
            <P>
              Each alert includes the app name, platform, build ID, and error message.
              The AI diagnosis analyzes the build log to suggest fixes — including monorepo issues,
              dependency conflicts, and configuration errors.
            </P>

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
              using <strong>OSV.dev</strong> (17+ vulnerability databases including NVD, GitHub Advisory, PyPA, RustSec, Go) as the primary source,
              with GitHub Advisory as automatic fallback. Lockfiles (<InlineCode>package-lock.json</InlineCode>, <InlineCode>yarn.lock</InlineCode>, <InlineCode>Cargo.lock</InlineCode>) are
              auto-detected for transitive dependency scanning with exact version matching.
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
              The <InlineCode>@inariwatch/capture</InlineCode> SDK captures errors, logs, and deploy markers
              from your app and sends them to InariWatch. Zero dependencies, zero config. Works as a standalone
              Sentry replacement or alongside your existing integrations.
            </P>

            <SubHeading id="int-capture-install">Quick start (zero config)</SubHeading>
            <CodeBlock label="One command">{`npx @inariwatch/capture`}</CodeBlock>
            <P>
              Auto-detects your framework (Next.js, Nuxt, Remix, SvelteKit, Astro, Vite, Express, Fastify, Node), installs
              the SDK, and sets up instrumentation for whichever stack it finds. If you have an InariWatch account,
              the CLI opens a browser to authorize and automatically writes <InlineCode>INARIWATCH_DSN</InlineCode> to
              your <InlineCode>.env</InlineCode> — no manual copy-paste.
            </P>
            <StepList steps={[
              { title: "Framework setup", body: "Detects 9 frameworks (Next, Nuxt, Remix, SvelteKit, Astro, Vite, Express, Fastify, Node). Installs the package and wires the right plugin automatically." },
              { title: "Browser authorization", body: "Opens app.inariwatch.com/cli/verify in your browser. Click Authorize — takes 5 seconds." },
              { title: "DSN written automatically", body: "INARIWATCH_DSN is written to .env.local (or .env). No signup or dashboard visit required." },
            ]} />
            <Callout type="info">
              No account? No problem. Skip the browser step and errors print to your terminal in local mode. You can connect to your dashboard later by running <InlineCode>npx @inariwatch/capture</InlineCode> again.
            </Callout>

            <SubHeading id="int-capture-frameworks">Framework setup</SubHeading>
            <P>
              Pick the section that matches your stack. All plugins inject git context
              (commit, branch, message) at build time and mark capture as external on
              server bundles so its <InlineCode>node:</InlineCode> builtin imports never leak into
              client or edge chunks.
            </P>

            <SubHeading id="int-capture-next">Next.js</SubHeading>
            <CodeBlock label="next.config.ts">{`import { withInariWatch } from "@inariwatch/capture/next"
export default withInariWatch(nextConfig)`}</CodeBlock>
            <P>And create <InlineCode>instrumentation.ts</InlineCode>:</P>
            <CodeBlock label="instrumentation.ts">{`import "@inariwatch/capture/auto"
import { captureRequestError } from "@inariwatch/capture"

export const onRequestError = captureRequestError`}</CodeBlock>

            <SubHeading id="int-capture-vite">Vite (Remix, SvelteKit, SolidStart, Qwik)</SubHeading>
            <P>
              Remix, SvelteKit, SolidStart, and Qwik all build with Vite under the hood, so the same plugin works for all of them.
            </P>
            <CodeBlock label="vite.config.ts">{`import { defineConfig } from "vite"
import { inariwatchVite } from "@inariwatch/capture/vite"

export default defineConfig({
  plugins: [inariwatchVite()],
})`}</CodeBlock>

            <SubHeading id="int-capture-nuxt">Nuxt 3</SubHeading>
            <CodeBlock label="nuxt.config.ts">{`export default defineNuxtConfig({
  modules: ["@inariwatch/capture/nuxt"],
})`}</CodeBlock>
            <P>
              The Nuxt module injects git context into <InlineCode>runtimeConfig.inariwatch</InlineCode> and marks
              capture as a Nitro external so it stays out of edge bundles.
            </P>

            <SubHeading id="int-capture-astro">Astro</SubHeading>
            <CodeBlock label="astro.config.mjs">{`import { defineConfig } from "astro/config"
import { inariwatchVite } from "@inariwatch/capture/vite"

export default defineConfig({
  vite: { plugins: [inariwatchVite()] },
})`}</CodeBlock>

            <SubHeading id="int-capture-webpack">webpack (CRA, Vue CLI, Angular, raw webpack)</SubHeading>
            <CodeBlock label="webpack.config.js">{`const { withInariWatchWebpack } = require("@inariwatch/capture/webpack")

module.exports = withInariWatchWebpack({
  // your existing webpack config
})`}</CodeBlock>

            <SubHeading id="int-capture-express">Express, Fastify, Koa, Hono, or any Node.js app</SubHeading>
            <CodeBlock label="CLI flag">{`node --import @inariwatch/capture/auto app.js`}</CodeBlock>
            <P>Or in your package.json:</P>
            <CodeBlock label="package.json">{`{ "scripts": { "start": "node --import @inariwatch/capture/auto src/index.js" } }`}</CodeBlock>
            <P>
              The <InlineCode>/auto</InlineCode> entrypoint reads <InlineCode>INARIWATCH_DSN</InlineCode> from the
              environment, starts the SDK before your app boots, and registers unhandled-rejection / uncaught-exception
              listeners. Works with Bun and Deno in Node-compat mode too.
            </P>

            <SubHeading id="int-capture-python">Python, Go, Rust, or anything non-Node</SubHeading>
            <P>
              For non-Node projects, use InariWatch&apos;s HTTP webhook ingest directly — no SDK required.
              Send JSON events to your project&apos;s capture endpoint and they show up in the dashboard
              alongside Node-captured errors.
            </P>
            <CodeBlock label="Python (requests)">{`import requests, traceback, os

def capture(err: Exception):
    requests.post(os.environ["INARIWATCH_DSN"], json={
        "type": "exception",
        "message": str(err),
        "stack": traceback.format_exc(),
        "environment": os.environ.get("ENVIRONMENT", "production"),
    })

try:
    risky_operation()
except Exception as e:
    capture(e)
    raise`}</CodeBlock>
            <CodeBlock label="Go (net/http)">{`import "net/http"
import "encoding/json"
import "bytes"

func capture(err error, stack string) {
    body, _ := json.Marshal(map[string]interface{}{
        "type":    "exception",
        "message": err.Error(),
        "stack":   stack,
    })
    http.Post(os.Getenv("INARIWATCH_DSN"), "application/json", bytes.NewReader(body))
}`}</CodeBlock>
            <P>
              Alternatively, run your app with the InariWatch Agent installed — it captures errors at the
              kernel level, language-agnostic, zero code changes. See the
              {" "}<a href="#int-agent" className="text-inari-accent underline">InariWatch Agent section</a> below.
            </P>

            <SubHeading id="int-capture-env">Environment variables</SubHeading>
            <P>
              Config is driven by environment variables — no DSN in source code.
              Omit <InlineCode>INARIWATCH_DSN</InlineCode> for local mode (terminal output).
            </P>
            <Table
              head={["Variable", "Description"]}
              rows={[
                ["INARIWATCH_DSN", "Capture endpoint. Omit for local mode."],
                ["INARIWATCH_ENVIRONMENT", "Environment tag (fallback: NODE_ENV)"],
                ["INARIWATCH_RELEASE", "Release version — triggers deploy marker"],
                ["INARIWATCH_SUBSTRATE", "Set to \"true\" to enable I/O recording"],
              ]}
            />

            <SubHeading id="int-capture-substrate">Substrate I/O recording</SubHeading>
            <P>
              Capture every HTTP call, DB query, and file operation alongside your errors.
              When <InlineCode>captureException()</InlineCode> fires, the last 60 seconds of I/O are uploaded automatically.
            </P>
            <CodeBlock label="Install">{`npm install @inariwatch/substrate-agent`}</CodeBlock>
            <CodeBlock label="Enable via env var">{`INARIWATCH_SUBSTRATE=true`}</CodeBlock>
            <P>Or programmatically:</P>
            <CodeBlock label="init()">{`init({ substrate: true })`}</CodeBlock>

            <SubHeading id="int-capture-api">API</SubHeading>
            <Table
              head={["Function", "Purpose", "Example"]}
              rows={[
                ["init(config?)", "Initialize SDK (reads from env vars)", "init() or init({ substrate: true })"],
                ["captureException(error)", "Capture exception with full stack trace", "captureException(err)"],
                ["captureLog(message, level?, meta?)", "Send structured log event", "captureLog(\"DB timeout\", \"error\", { query })"],
                ["captureMessage(message, level?)", "Send plain text event", "captureMessage(\"Deploy started\", \"info\")"],
                ["flush()", "Wait for pending events (call before exit)", "await flush()"],
                ["addBreadcrumb({ message, category?, level? })", "Add custom breadcrumb", "addBreadcrumb({ message: \"checkout started\" })"],
                ["setUser({ id?, role? })", "Set user context (email stripped for privacy)", "setUser({ id: \"u123\", role: \"admin\" })"],
                ["setTag(key, value)", "Set custom tag for filtering", "setTag(\"feature\", \"checkout\")"],
                ["setRequestContext({ method, url, headers?, body? })", "Set HTTP request context", "setRequestContext({ method: \"POST\", url: \"/api/users\" })"],
              ]}
            />

            <SubHeading id="int-capture-context">Automatic context</SubHeading>
            <P>
              Every error automatically includes rich context — no code changes needed.
              Your AI gets the full picture without guessing.
            </P>
            <Table
              head={["Context", "How it works", "What the AI sees"]}
              rows={[
                ["Git", "Injected at build time by withInariWatch — commit, branch, message", "\"commit f5eface on main — refactor session handling (23 min ago)\""],
                ["Breadcrumbs", "Auto-intercepts console.log + fetch — last 30 actions", "GET /auth/session → 200 → console.log(\"Processing\") → POST /api/users → 500"],
                ["Environment", "Node version, OS, memory, CPU at crash time", "Node v20, linux, heap 890/1130MB, uptime 24h"],
                ["Request", "Full HTTP request (headers redacted, body scrubbed)", "POST /api/users { role: \"admin\" }"],
                ["User", "Set via setUser() — id + role only (email stripped)", "user_456 (admin)"],
                ["Tags", "Set via setTag() — custom key-value pairs", "feature=checkout, plan=pro"],
              ]}
            />
            <p className="text-sm text-fg-base mt-2">
              Sensitive data is scrubbed automatically: Bearer tokens, JWTs, passwords, API keys, credit card numbers,
              connection strings, and auth headers are all redacted before leaving your app.
            </p>

            <SubHeading id="int-capture-exports">Import paths</SubHeading>
            <Table
              head={["Import", "Description"]}
              rows={[
                ["@inariwatch/capture", "SDK — init, captureException, captureLog, flush"],
                ["@inariwatch/capture/auto", "Auto-init on import — config from env vars"],
                ["@inariwatch/capture/browser", "Browser entry — error + unhandled rejection listeners"],
                ["@inariwatch/capture/next", "Next.js plugin — withInariWatch()"],
                ["@inariwatch/capture/vite", "Vite plugin — inariwatchVite() (Vite + Remix + SvelteKit + Astro + SolidStart + Qwik)"],
                ["@inariwatch/capture/webpack", "webpack wrapper — withInariWatchWebpack() (CRA, Vue CLI, Angular)"],
                ["@inariwatch/capture/nuxt", "Nuxt 3 module — add to modules: []"],
                ["@inariwatch/capture/shield", "Runtime security — source-to-sink attack detection"],
              ]}
            />
            <Callout type="tip">
              In serverless environments, call <InlineCode>await flush()</InlineCode> before the function returns
              to ensure events are sent.
            </Callout>

            {/* ────────────────────────────────────────────────────────────────
                SHIELD — RUNTIME SECURITY
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="int-shield">Shield — Runtime Security</SectionHeading>
            <P>
              Shield detects security vulnerabilities <strong>at runtime</strong> by tracking user input
              from the request to dangerous operations (database queries, shell commands, file reads).
              Unlike a regex WAF, Shield has near-zero false positives because it detects the <strong>vulnerability</strong>,
              not the attack attempt.
            </P>

            <SubHeading id="int-shield-setup">Setup</SubHeading>
            <P>Add one import to your instrumentation file:</P>
            <CodeBlock label="instrumentation.ts">{`import "@inariwatch/capture/auto"
import "@inariwatch/capture/shield"
import { captureRequestError } from "@inariwatch/capture"
export const onRequestError = captureRequestError`}</CodeBlock>

            <P>For Express/Fastify, use the middleware:</P>
            <CodeBlock label="app.ts">{`import { shield } from "@inariwatch/capture/shield"

app.use(shield()) // report-only (default)
// or
app.use(shield({ mode: "block" })) // block threats`}</CodeBlock>

            <SubHeading id="int-shield-detects">What it detects</SubHeading>
            <Table
              head={["Vulnerability", "Sink hooked", "Example"]}
              rows={[
                ["SQL Injection", "pg.query, mysql2.query", "User input in string-concatenated query"],
                ["Command Injection", "child_process.exec", "User input in shell command"],
                ["Path Traversal", "fs.readFile, fs.writeFile", "../../etc/passwd in file path"],
                ["SSRF", "fetch, http.request", "Internal IP in user-controlled URL"],
                ["NoSQL Injection", "mongodb.find", "$ne operator in user input"],
                ["Prototype Pollution", "JSON.parse", "__proto__ key in request body"],
              ]}
            />

            <SubHeading id="int-shield-flow">How it works</SubHeading>
            <P>
              1. User sends <InlineCode>{`'; DROP TABLE users--`}</InlineCode> as a search query.<br />
              2. Shield marks it as <strong>tainted</strong> (came from user request).<br />
              3. Your app passes it to <InlineCode>pg.query({"\"SELECT * WHERE name = '\" + input + \"'\""}</InlineCode>.<br />
              4. Shield detects tainted input inside the SQL string.<br />
              5. Reports to InariWatch: file, line, sink, source, input.<br />
              6. InariWatch AI reads the code and creates a PR with a parameterized query fix.
            </P>

            <SubHeading id="int-shield-modes">Modes</SubHeading>
            <Table
              head={["Mode", "Behavior", "Use case"]}
              rows={[
                ["report (default)", "Detect and report to dashboard. Request continues.", "Production monitoring"],
                ["block", "Return 403. Request rejected before sink executes.", "Active protection"],
              ]}
            />

            <Callout type="tip">
              Start with report mode. Review alerts in the dashboard. Enable block mode when confident
              in the detection accuracy for your app.
            </Callout>

            <SubHeading id="int-shield-alerts">Security alerts</SubHeading>
            <P>
              Shield events appear as <strong>security alerts</strong> in the dashboard with full context:
              vulnerability type, sink function, source input, file, and line number. The AI auto-analyze
              prompt is tailored for security — it assesses if the vulnerability is real, what the impact is,
              and how to fix it. Click <strong>Fix with AI</strong> to auto-generate a parameterized query,
              input sanitization, or safe API call.
            </P>

            {/* ────────────────────────────────────────────────────────────────
                INARIWATCH AGENT
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="int-agent">InariWatch Agent — Kernel-level observability</SectionHeading>
            <P>
              The InariWatch Agent captures <strong>everything that happens in your kernel</strong> —
              process execution, network connections, file access, DNS queries, TLS plaintext, and security
              events (LSM hooks) — without requiring any SDK in your code. It uses eBPF under the hood
              and is language-agnostic: works with Node.js, Python, Go, Java, Rust, or any production process.
            </P>
            <P>
              While <InlineCode>@inariwatch/capture</InlineCode> catches application errors from within
              your code, the InariWatch Agent watches your <em>entire server</em> from the kernel. It detects
              threats that code-level instrumentation cannot see — SSRF to cloud metadata endpoints, reverse
              shells, web shell uploads, container escapes, sensitive file reads, and more.
            </P>

            <SubHeading id="int-agent-install">Quick install</SubHeading>
            <P>
              Create an integration at <strong>Dashboard → Integrations → InariWatch Agent</strong> to get your
              credentials, then run this one-liner on your Linux server (as root):
            </P>
            <CodeBlock label="One-line installer">{`curl -sf https://install.inariwatch.com | sudo sh -s -- \\
  --integration-id <your-uuid> \\
  --secret <your-secret>`}</CodeBlock>
            <P>
              Or via environment variables:
            </P>
            <CodeBlock label="Env var install">{`IW_INTEGRATION_ID=<uuid> IW_SECRET=<secret> \\
  bash -c "$(curl -sf https://install.inariwatch.com)"`}</CodeBlock>

            <SubHeading id="int-agent-requirements">Requirements</SubHeading>
            <ul className="mb-4 space-y-1.5 text-sm text-fg-base">
              {[
                "Linux kernel >= 5.8 with BTF support (check: ls /sys/kernel/btf/vmlinux)",
                "Architecture: x86_64 or aarch64",
                "Distros: Ubuntu 22.04+, Debian 12+, RHEL 9+, Fedora 38+, Amazon Linux 2023+",
                "Root access (or CAP_BPF, CAP_PERFMON, CAP_NET_ADMIN, CAP_SYS_RESOURCE)",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
                  {f}
                </li>
              ))}
            </ul>

            <SubHeading id="int-agent-probes">What it captures</SubHeading>
            <P>The agent loads 7 eBPF programs into your kernel:</P>
            <Table
              head={["Probe", "Captures", "Hook type"]}
              rows={[
                ["Process", "exec, exit, fork", "tracepoint/sched"],
                ["Network", "TCP connect/accept/close, retransmits", "tracepoint/sock + kprobe/tcp_*"],
                ["Filesystem", "file open, write, delete", "kprobe/vfs_open, vfs_write, vfs_unlink"],
                ["DNS", "all DNS queries (parsed in userspace)", "kprobe/udp_sendmsg"],
                ["TLS", "plaintext from OpenSSL + Go crypto/tls", "uprobe on SSL_read/SSL_write"],
                ["Syscall", "any syscall via raw tracepoint", "raw_tracepoint/sys_enter"],
                ["Security (LSM)", "exec, socket, capability, namespace", "LSM hooks (needs BPF LSM)"],
              ]}
            />
            <P>
              Events are batched (1000 events / 256KB / 5s window), compressed with LZ4 (~88% ratio),
              and sent over HTTPS to the InariWatch cloud. Threat detection runs in the cloud pipeline.
            </P>

            <SubHeading id="int-agent-threats">Threat detection</SubHeading>
            <P>The cloud pipeline analyzes events and creates alerts for:</P>
            <ul className="mb-4 space-y-1.5 text-sm text-fg-base">
              {[
                "SQL injection, XSS, command injection (via TLS plaintext interception)",
                "SSRF to cloud metadata (169.254.169.254, metadata.google.internal, etc.)",
                "Reverse shell attempts (/dev/tcp, mkfifo, bash -i)",
                "Web shell uploads (.php, .jsp, .asp in web directories)",
                "Sensitive file access (/etc/shadow, SSH keys, cloud credentials)",
                "Malicious DNS queries (known C2 / exfiltration domains)",
                "Container escape attempts (namespace manipulation)",
                "Suspicious process execution (nc, nmap, wget from web processes)",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
                  {f}
                </li>
              ))}
            </ul>

            <SubHeading id="int-agent-config">Configuration</SubHeading>
            <P>
              The installer creates <InlineCode>/etc/inariwatch/agent.toml</InlineCode>. Edit it to
              enable optional probes (TLS interception, BPF LSM security hooks) or tune batching:
            </P>
            <CodeBlock label="/etc/inariwatch/agent.toml">{`[cloud]
endpoint = "https://app.inariwatch.com/api/agent/events"
integration_id = "your-uuid"
webhook_secret = "your-secret"

[agent]
log_level = "info"

[probes]
enable_process = true
enable_network = true
enable_filesystem = true
enable_dns = true
enable_tls = true          # captures plaintext from OpenSSL/Go crypto/tls
enable_syscall = true
enable_security = false    # needs CONFIG_BPF_LSM in kernel`}</CodeBlock>
            <P>Restart after editing:</P>
            <CodeBlock label="Shell">{`sudo systemctl restart inariwatch-agent`}</CodeBlock>

            <SubHeading id="int-agent-verify">Release verification</SubHeading>
            <P>
              The install script pins release binaries by SHA-256 and will refuse to install a tampered file.
              Supply-chain signing via <a href="https://github.com/sigstore/cosign" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">cosign<ExternalLink className="h-3 w-3" aria-hidden="true" /></a> and{" "}
              <a href="https://slsa.dev/spec/v1.0/levels#build-l3" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">SLSA Level 3<ExternalLink className="h-3 w-3" aria-hidden="true" /></a> provenance
              attestation are planned for the 1.0 release.
            </P>

            <SubHeading id="int-agent-manage">Service management</SubHeading>
            <CodeBlock label="Shell">{`sudo systemctl status inariwatch-agent       # check running state
sudo journalctl -u inariwatch-agent -f       # live logs
sudo systemctl restart inariwatch-agent      # after config changes
sudo systemctl stop inariwatch-agent         # pause monitoring`}</CodeBlock>

            <SubHeading id="int-agent-uninstall">Uninstall</SubHeading>
            <CodeBlock label="Shell">{`curl -sf https://install.inariwatch.com | sudo sh -s -- --uninstall`}</CodeBlock>

            <SubHeading id="int-agent-performance">Performance</SubHeading>
            <ul className="mb-4 space-y-1.5 text-sm text-fg-base">
              {[
                "~250 events/second throughput (measured)",
                "~88% LZ4 compression ratio",
                "< 1% CPU overhead",
                "~48 MB RAM",
                "Zero kernel event drops under normal load",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
                  {f}
                </li>
              ))}
            </ul>

            <Callout type="info">
              The source code of the agent is private. Binary releases are distributed via{" "}
              <a href="https://github.com/orbita-pos/inariwatch-agent-releases/releases" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">
                orbita-pos/inariwatch-agent-releases<ExternalLink className="h-3 w-3" />
              </a>{" "}
              (public). Contact <InlineCode>info@jesusbr.com</InlineCode> for commercial
              licensing or security audits.
            </Callout>

            {/* ────────────────────────────────────────────────────────────────
                AI SETUP
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="ai-overview">AI setup — Overview</SectionHeading>
            <P>
              <strong>Alert analysis and correlation work out of the box — no AI key required.</strong>{" "}
              InariWatch provides built-in AI for basic alert analysis so you get value from day one.
            </P>
            <P>
              Adding your own AI key (Bring Your Own Key) unlocks advanced features:
            </P>
            <ul className="mb-4 space-y-1.5 text-sm text-fg-base">
              {[
                "AI code remediation — writes the fix, pushes a branch, waits for CI, opens a PR",
                "Pre-deploy PR risk scoring (GitHub integration required)",
                "Auto post-mortems when an incident is resolved",
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
                ["claude-sonnet-4-6 (recommended)",   "200k", "Remediation, correlation, chat"],
                ["claude-haiku-4-5-20251001",         "200k", "Fast analysis, lower cost"],
                ["claude-opus-4-6",                   "200k", "Complex repos, maximum quality"],
              ]}
            />
            <CodeBlock label="CLI">{`inariwatch config --ai-key sk-ant-api03-... --model claude-sonnet-4-6`}</CodeBlock>

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
                ["gpt-5.4 (recommended)", "Flagship — code fixes, remediation"],
                ["gpt-5-mini",            "Reasoning + long-form writing (postmortems)"],
                ["gpt-4.1-mini",          "1M context, balanced analysis"],
                ["gpt-4o-mini",           "Fast & cheap — alert analysis, chat"],
              ]}
            />
            <CodeBlock label="CLI">{`inariwatch config --ai-key sk-proj-... --model gpt-4o-mini`}</CodeBlock>

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
            <Table
              head={["Model", "Best for"]}
              rows={[
                ["grok-3-beta (recommended)", "Most capable — remediation & postmortems"],
                ["grok-2-1212",               "Balanced chat and analysis"],
                ["grok-2-mini-1212",          "Fast & cheap — alert analysis"],
              ]}
            />
            <CodeBlock label="CLI">{`inariwatch config --ai-key xai-... --model grok-3-beta`}</CodeBlock>

            <SectionHeading id="ai-groq">AI — Groq (Llama)</SectionHeading>
            <P>
              Groq runs Llama 3.1 at very high throughput — several times faster than other providers.
              Best for ultra-fast alert analysis and chat where latency matters more than absolute quality.
            </P>
            <StepList steps={[
              {
                title: "Create an API key",
                body: <><a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-inari-accent underline underline-offset-2">console.groq.com/keys <ExternalLink className="h-3 w-3" /></a></>,
              },
              {
                title: "Copy the key",
                body: <>Starts with <InlineCode>gsk_...</InlineCode></>,
              },
              { title: "Paste into InariWatch", body: "Settings → AI analysis → Add key → Select Groq (Llama)." },
            ]} />
            <Table
              head={["Model", "Best for"]}
              rows={[
                ["llama-3.1-70b-versatile", "Fast analysis & chat (recommended)"],
                ["llama-3.1-8b-instant",    "Ultra-fast, lowest cost"],
                ["mixtral-8x7b-32768",      "Mixture-of-experts balanced"],
              ]}
            />
            <CodeBlock label="CLI">{`inariwatch config --ai-key gsk_... --model llama-3.1-70b-versatile`}</CodeBlock>

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
            <Table
              head={["Model", "Best for"]}
              rows={[
                ["deepseek-chat",      "V3 — fast analysis, chat, postmortems"],
                ["deepseek-reasoner",  "R1 — deep reasoning, remediation"],
              ]}
            />
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
            <Table
              head={["Model", "Best for"]}
              rows={[
                ["gemini-1.5-pro",    "Remediation & postmortems (recommended)"],
                ["gemini-1.5-flash",  "Fast analysis & chat"],
                ["gemini-2.0-flash",  "Latest — fast, experimental"],
              ]}
            />
            <CodeBlock label="CLI">{`inariwatch config --ai-key AIza... --model gemini-1.5-pro`}</CodeBlock>

            {/* ────────────────────────────────────────────────────────────────
                AUTONOMOUS MODE
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="auto-remediate">Autonomous Mode — Auto-Remediate</SectionHeading>
            <P>
              When enabled, InariWatch automatically triggers the full AI remediation pipeline on critical alerts — no human click needed.
              The developer wakes up to: {'"'}We had an incident at 3 AM. It{"'"}s already fixed.{'"'}
            </P>
            <StepList steps={[
              { title: "Enable", body: "Project Settings → Auto-Merge → toggle Autonomous mode (amber)." },
              { title: "Critical alert arrives", body: "AI diagnosis runs automatically, then the full pipeline: read code → generate fix → self-review → push → CI → PR." },
              { title: "Safety gates apply", body: "All 11 gates must pass for auto-merge. If any gate fails, a draft PR is created for manual review instead." },
            ]} />
            <Callout type="warn">
              Autonomous mode requires auto-merge to be enabled. All existing safety gates (confidence, self-review, CI, lines changed, Substrate risk, EAP verification) still apply.
            </Callout>

            <SubHeading id="auto-remediate-suggestion">Autonomous mode suggestion</SubHeading>
            <P>
              You don{"'"}t need to enable autonomous mode manually. InariWatch watches your approval history and suggests it automatically
              when the data justifies the trust.
            </P>
            <P>
              After each approved fix, InariWatch checks the last 30 days of remediation sessions for that project.
              If <strong>5 or more</strong> sessions exist and the approval rate is <strong>≥ 90%</strong>, a banner appears
              at the top of the project page:
            </P>
            <Callout type="info">
              {'"'}Your last N fixes were approved X% of the time. Enable autonomous mode?{'"'} — Click Enable or dismiss permanently.
            </Callout>
            <P>
              Clicking Enable sets <InlineCode>autoRemediate: true</InlineCode> and clears the banner.
              Dismissing hides it permanently for that project. The suggestion never reappears once dismissed.
            </P>

            <SubHeading id="auto-remediate-tune">Auto-tune confidence threshold</SubHeading>
            <P>
              The minimum confidence threshold (<InlineCode>minConfidence</InlineCode>) controls which AI fixes are eligible for auto-merge.
              InariWatch adjusts this threshold automatically based on your project{"'"}s actual approval history — no manual tuning needed.
            </P>
            <Table
              head={["Condition", "Action"]}
              rows={[
                ["Approval rate ≥ 80% (last 30 days, ≥ 8 sessions)", "Lowers threshold to min_approved_confidence − 3 (floor: 55)"],
                ["Approval rate < 50% (last 30 days, ≥ 3 cancellations)", "Raises threshold to median_cancelled_confidence + 5 (cap: 95)"],
                ["Change < 5 points", "No adjustment — avoids noise from small fluctuations"],
              ]}
            />
            <P>
              When auto-tune adjusts the threshold, the new value is shown in Project Settings → Auto-Merge next to the
              confidence input: <em>Auto-tuned 70 → 65 · 3 days ago</em> with a trend arrow.
            </P>

            <SectionHeading id="auto-heal">Autonomous Mode — Auto-Heal</SectionHeading>
            <P>
              When your site goes down, InariWatch automatically rolls back to the last successful deploy and starts an AI fix in the background.
              Total downtime: ~90 seconds.
            </P>
            <StepList steps={[
              { title: "Enable", body: "Project Settings → Auto-Merge → toggle Auto-heal (red). Requires a hosting integration (Vercel, Netlify, Cloudflare Pages, or Render)." },
              { title: "Uptime detects failure", body: "3 consecutive ping failures (not just 1) confirm the site is down. Prevents false positives." },
              { title: "Rollback", body: "Automatically rolls back to the last successful deploy on whichever host the project uses. Site is back online in ~30 seconds." },
              { title: "AI fix", body: "Remediation starts in background. When the fix is ready, a new deploy replaces the rollback with everything + the fix." },
              { title: "Cooldown", body: "10-minute cooldown between auto-heal triggers prevents loops if the issue is not code-related (DB down, DNS, etc.)." },
            ]} />

            <SectionHeading id="staging-verification">Staging Verification</SectionHeading>
            <P>
              Before any fix reaches production, InariWatch deploys it to an ephemeral staging environment.
              A Playwright bot replays the exact HTTP requests from the Substrate recording — the same actions that
              caused the original crash — against the fixed code. If the error persists, the AI retries with a different
              approach. If it passes, the fix proceeds to the auto-merge safety gates.
            </P>
            <StepList steps={[
              { title: "Fix generated", body: "AI generates a code fix and pushes it to a branch." },
              { title: "Staging deploy", body: "The fix branch is deployed to an isolated Docker container with its own URL (e.g. fix-abc.staging.inariwatch.com)." },
              { title: "Bot verification", body: "A headless Chromium browser replays the recorded user session against the staging URL. Checks for 500 errors, console exceptions, and response correctness." },
              { title: "Result", body: "If the bot confirms the fix works, it proceeds to the 11 safety gates. If it fails, AI retries with a different approach (up to 2 retries)." },
              { title: "Cleanup", body: "The staging container is automatically destroyed after verification (5 min TTL). No manual cleanup needed." },
            ]} />

            <SectionHeading id="staging-env">Staging Environment Variables</SectionHeading>
            <P>
              When AI remediation verifies a fix, it deploys the code to an ephemeral staging container.
              If your app needs environment variables to start (database URL, auth secrets, API keys),
              configure them in <strong>Project Settings → Staging Environment Variables</strong>.
            </P>

            <SubHeading id="staging-env-setup">Setup</SubHeading>
            <P>
              Go to your project settings page (<InlineCode>/projects/your-project-slug</InlineCode>) and
              find the <strong>Staging Environment Variables</strong> section. Add key-value pairs:
            </P>
            <Table
              head={["Variable", "Example", "Notes"]}
              rows={[
                ["DATABASE_URL", "postgresql://user:pass@host/db", "Required if your app uses a database"],
                ["NEXTAUTH_SECRET", "random-string-here", "Required for Next.js auth"],
                ["NEXTAUTH_URL", "http://localhost:3000", "Any valid URL — staging overrides it"],
              ]}
            />

            <Callout type="tip">
              Values are encrypted at rest (AES-256-GCM) and never shown after saving — only the key names
              are visible. The full values are decrypted server-side only when deploying a staging container.
            </Callout>

            <SubHeading id="staging-env-behavior">How it works</SubHeading>
            <StepList steps={[
              { title: "AI generates a fix", body: "The remediation pipeline creates a fix branch and pushes it to GitHub." },
              { title: "Staging deploys the fix", body: "An ephemeral Docker container is created with your fix branch. Your staging env vars are injected into the container at startup." },
              { title: "Bot verifies", body: "A headless browser checks that the app starts and responds correctly." },
              { title: "Container destroyed", body: "After verification (pass or fail), the container and all env vars are destroyed. TTL is 5 minutes." },
            ]} />

            <SubHeading id="staging-env-without">Without staging env vars</SubHeading>
            <P>
              If no staging env vars are configured, the staging gate is <strong>skipped</strong> — not failed.
              The PR is still created, CI still runs, and all other safety gates still apply. Staging verification
              is an optional extra layer of confidence.
            </P>

            <SectionHeading id="preview-fix">Preview Fix</SectionHeading>
            <P>
              When an autonomous remediation completes, Preview Fix renders the merged fix two ways:
              an <strong>AI prediction</strong> you can look at in 2–3 seconds, and a <strong>live
              sandbox</strong> running the fix branch in an ephemeral Docker container for 24 hours.
              Every preview gets a shareable public URL with a cryptographic receipt from the EAP chain.
            </P>

            <Callout type="info">
              Preview Fix reuses the same <InlineCode>staging_env</InlineCode> you configured above.
              Same vars, same encryption, same model — the fix branch runs with those values. Use
              preview-specific credentials (throwaway DB branch, test Stripe keys), not production.
            </Callout>

            <SubHeading id="preview-fix-enable">Enable it for your workspace</SubHeading>
            <P>
              Preview Fix is behind a feature flag while we onboard early users. Set the allowlist on
              the Vercel deployment or your local <InlineCode>.env.local</InlineCode>:
            </P>
            <CodeBlock label=".env">{`PREVIEW_FIX_ORGS=<your-org-uuid>
PREVIEW_FIX_USERS=<your-user-uuid>
# Either flag is enough — set both if the project lives in a personal workspace
# and also appears under an org.

# Kill switch — returns 503 on /api/alerts/:id/preview if set to "1".
# Existing previews still render from DB; no new ones get kicked off.
PREVIEW_FIX_KILL=`}</CodeBlock>
            <P>
              Once the flag includes your org or user id, every alert detail page with a completed +
              merged remediation renders the Preview Fix panel automatically. No per-project toggle.
            </P>

            <SubHeading id="preview-fix-how">How it works</SubHeading>
            <StepList steps={[
              { title: "Alert page renders", body: <>The <InlineCode>{`<PreviewPanel>`}</InlineCode> component POSTs to <InlineCode>/api/alerts/:id/preview</InlineCode>. Idempotent — the same remediation always returns the same preview row, even across refreshes.</> },
              { title: "Tier 3 — AI prediction", body: "GPT-5.4 reads the last DOM snapshot from your Substrate recording, applies the fix diff, and returns predicted HTML. Cached per (alert, merged commit sha) so refreshes cost 0¢. Typical budget: ~$0.04 per cache miss." },
              { title: "Tier 1 — Live sandbox", body: <>A Go staging server on Hetzner clones the fix branch, auto-generates a Dockerfile for the detected framework (Next.js, Express, generic), and runs <InlineCode>docker run</InlineCode> behind a dynamic <InlineCode>preview-&lt;id&gt;.staging.inariwatch.com</InlineCode> Caddy route. TTL 24h.</> },
              { title: "Screenshot captured", body: <>The moment Tier 1 reaches <InlineCode>running</InlineCode>, a Playwright worker captures a 1280×800 PNG of the home page and uploads it to Cloudflare R2. The panel polls the preview row every 2s and swaps the skeleton for the hero image when it lands.</> },
              { title: "Share", body: <>The panel footer exposes a 12-character capability URL (<InlineCode>app.inariwatch.com/preview/&lt;slug&gt;</InlineCode>). Paste it in Slack or Twitter — the OG unfurl shows the real screenshot.</> },
            ]} />

            <SubHeading id="preview-fix-ui">What you see in the panel</SubHeading>
            <Table
              head={["State", "Panel shows"]}
              rows={[
                ["creating", "3-line Anthropic-style shimmer (≤200ms)"],
                ["building", "“Provisioning preview container…”"],
                ["starting", "Container booting — waiting for health check"],
                ["running, no screenshot yet", "Big centered “Open live preview” CTA + “Capturing screenshot…” spinner"],
                ["running + screenshot ready", "Hero card with the real image, overlay CTAs, optional “Try embedded view”"],
                ["failed", "Amber error card with the last ~40 lines of the build log + “Use AI prediction instead” CTA"],
                ["expired", "Muted card — the 24h window closed; the fix is still merged in production"],
                ["revoked", "Footer shows “Revoked” badge, public URL returns 410 Gone"],
              ]}
            />

            <SubHeading id="preview-fix-revoke">Revoking a share URL</SubHeading>
            <P>
              The project owner or any org member can revoke a share URL by clicking <strong>Revoke</strong>
              in the panel footer. The public <InlineCode>/preview/&lt;slug&gt;</InlineCode> page then returns
              410 Gone with a friendly notice. The live container and screenshot stay — revoke is a
              visibility signal, not a destruction op.
            </P>
            <Callout type="warn">
              Social unfurls cache aggressively. Revoking does <strong>not</strong> remove an already-fetched
              Twitter / Slack / LinkedIn OG image. Visitors who click through land on the revocation
              notice, but the image itself may persist in third-party caches for days.
            </Callout>

            <SubHeading id="preview-fix-infra">Infrastructure prerequisites</SubHeading>
            <P>
              Preview Fix depends on three self-hosted pieces already used by Gate 14 (Staging E2E) and
              Replay v2. If you're running your own InariWatch instance, verify these are configured:
            </P>
            <Table
              head={["Component", "Env vars", "Purpose"]}
              rows={[
                ["Hetzner Go staging server", "STAGING_SERVER_URL, STAGING_API_SECRET", "Builds + runs the fix branch in a Docker container with dynamic Caddy routing"],
                ["Hetzner Node worker (Playwright)", "WORKER_URL (same host as STAGING_SERVER_URL, Caddy routes /worker/* to port 9401)", "Captures the hero screenshot via Chromium"],
                ["Cloudflare R2", "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET", "Permanent CDN-served storage for screenshots"],
                ["Neon Postgres", "DATABASE_URL", "Preview sessions, predictions cache, screenshot metadata"],
              ]}
            />

            <SubHeading id="preview-fix-trouble">Troubleshooting</SubHeading>
            <Table
              head={["Symptom", "Likely cause", "Fix"]}
              rows={[
                ["Panel never appears on the alert page", "Feature flag doesn't include your org or user, OR the alert has no completed+merged remediation", "Set PREVIEW_FIX_ORGS / PREVIEW_FIX_USERS; verify the remediation has mergedCommitSha"],
                ["Live build failed — “Staging server not configured”", "STAGING_SERVER_URL or STAGING_API_SECRET missing", "Add both to the environment and restart the web app"],
                ["Live build failed — “No GitHub integration for project”", "The project has no active github integration row (disconnected or never connected)", "Connect GitHub from /integrations on the project"],
                ["Live build failed — “GitHub token was rejected”", "The PAT expired or was revoked", "Rotate the PAT on GitHub, reconnect from /integrations. The health banner flags this automatically."],
                ["Stuck on “Capturing screenshot…”", "WORKER_URL missing OR worker can't reach Playwright OR Caddy doesn't route /worker/*", <>Verify WORKER_URL matches your STAGING_SERVER_URL host. Confirm Caddy has a <InlineCode>handle /worker/*</InlineCode> rule forwarding to port 9401. Hit <InlineCode>GET /worker/health</InlineCode> (no auth needed) to verify.</>],
                ["Screenshot unavailable — “worker returned 500: page.goto: net::ERR_SSL_PROTOCOL_ERROR”", "Transient — the ACME cert for the new preview subdomain hasn't issued yet", "The worker retries automatically up to 4 times with 3s × attempt backoff. If it persists past ~30s, check that Caddy is issuing certs via your DNS-01 provider."],
                ["Container stuck on “starting”, never transitions to “running”", "The app inside the container is crashing at boot", <>SSH to Hetzner, find the container name via <InlineCode>docker ps --filter label=inari.staging.id</InlineCode>, then <InlineCode>docker logs &lt;name&gt;</InlineCode>. Most common: missing env var the app needs for SSR — add it to Project Settings → Staging environment variables.</>],
                ["Tier 3 shows “n/a”", "The alert has no Substrate recording, so there's no DOM snapshot to predict from", "Server errors / background jobs don't record UI events — Tier 3 only works on alerts with rrweb data. Tier 1 still runs."],
                ["Public /preview/<slug> page 404", "Revoked preview, or invalid slug (wrong length / characters)", "410 means revoked; 404 means slug mismatch. Verify you copied the full 12-char base32 slug from the panel."],
                ["OG unfurl on Twitter/Slack shows the gradient card, not the screenshot", "The screenshot capture hadn't completed when the social crawler first hit the page", "Force a re-scrape (Twitter: /i/cards; Slack: post the URL again after the screenshot arrives). Crawlers cache OG aggressively."],
              ]}
            />

            <SubHeading id="preview-fix-cost">Cost envelope</SubHeading>
            <P>
              At 1,000 previews / month a Pro-tier workload currently runs ~$40 in Claude / GPT costs
              (70% cache miss assumed) plus ~$60 in Hetzner container lifetime (CX22 already fixed cost,
              so this is overlap, not marginal). R2 egress is effectively free. Total marginal cost per
              preview: ~$0.10.
            </P>

            <SectionHeading id="community-fixes">Autonomous Mode — Community Fixes</SectionHeading>
            <P>
              Every fix that gets approved is automatically and anonymously contributed to the community network.
              When a new error matches a known pattern, the fix appears instantly on the alert with its success rate —
              no AI generation needed.
            </P>
            <P>
              Example: {'"'}12 teams hit this error. Community fix available — one click to apply.{'"'}
            </P>
            <P>
              Click <strong>Apply Community Fix</strong> to use the proven fix instead of generating a new one.
              The more teams use InariWatch, the faster everyone{"'"}s errors get fixed. This is the network effect.
            </P>
            <SubHeading id="community-fixes-contribute">How auto-contribute works</SubHeading>
            <StepList steps={[
              { title: "Fix approved", body: "When you approve an AI-generated fix, it is automatically contributed to the network. No action required." },
              { title: "Anonymization", body: "All PII, secrets, API keys, IPs, URLs, and file contents are stripped before contribution. Only file paths, the fix approach, and confidence score are shared." },
              { title: "Deduplication", body: "If another team already contributed a fix for the same error fingerprint with the same approach, the success count is incremented instead of creating a duplicate." },
              { title: "Network effect", body: "As more teams use InariWatch, common framework errors accumulate high-confidence fixes. New errors skip AI generation entirely and resolve in seconds." },
            ]} />

            {/* ────────────────────────────────────────────────────────────────
                SLACK BOT
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="slack-setup">Slack Bot — Setup</SectionHeading>
            <P>
              The InariWatch Slack bot brings error monitoring, AI diagnosis, and auto-remediation directly into Slack.
              No more switching tabs — see errors, read the diagnosis, trigger fixes, and merge PRs without leaving your chat.
            </P>
            <StepList steps={[
              { title: "Install to Slack", body: "Go to Settings → Slack → click Install Slack Bot. Authorize InariWatch in your Slack workspace." },
              { title: "Map channels", body: "After installing, map each project to a Slack channel (e.g. api-service → #alerts-api). Alerts for that project will appear in the mapped channel." },
              { title: "Link your account", body: <>In Slack, run <InlineCode>/inariwatch link your@email.com</InlineCode> to connect your Slack user to your InariWatch account. This enables interactive actions.</> },
            ]} />
            <Callout type="info">
              The bot requires 3 environment variables on Vercel: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_SIGNING_SECRET.
            </Callout>

            <SectionHeading id="slack-commands">Slack Bot — Commands (14)</SectionHeading>
            <Table
              head={["Command", "Description"]}
              rows={[
                ["/inariwatch status", "Overview: open alert count, critical alerts, who is on-call"],
                ["/inariwatch alerts [severity] [--resolved]", "List alerts with optional severity filter (critical, warning, info)"],
                ["/inariwatch fix <id>", "Trigger AI remediation for an alert (diagnose, fix, PR)"],
                ["/inariwatch oncall", "Show current on-call rotation for all your projects"],
                ["/inariwatch oncall swap @user", "Create a 24-hour on-call override for another user"],
                ["/inariwatch trends [days]", "Error trends: top recurring errors, period comparison (default: 7 days)"],
                ["/inariwatch ask <question>", "Ask Inari AI about your infrastructure in natural language"],
                ["/inariwatch uptime", "Check all uptime monitors with status codes and response times"],
                ["/inariwatch rollback <project>", "Rollback to previous production deploy on any supported host (Vercel, Netlify, CF Pages, Render)"],
                ["/inariwatch maintenance <project> <mins>", "Create a maintenance window (suppresses alerts)"],
                ["/inariwatch maintenance list", "Show active maintenance windows"],
                ["/inariwatch search <error text>", "Search community fix network for known solutions"],
                ["/inariwatch integrations", "Health check: status of all connected services"],
                ["/inariwatch link <email>", "Link your Slack account to your InariWatch account"],
              ]}
            />

            <SubHeading id="slack-actions">Button actions (10)</SubHeading>
            <p>
              These buttons appear on alert messages and remediation threads:
            </p>
            <Table
              head={["Button", "Where", "What it does"]}
              rows={[
                ["Acknowledge", "Alert message", "Mark alert as read"],
                ["Resolve", "Alert message", "Mark alert as resolved"],
                ["Reopen", "Resolved alerts", "Reopen a resolved alert"],
                ["Fix It", "Alert message", "Trigger full AI remediation pipeline"],
                ["Apply Community Fix", "Community fix suggestion", "Apply a known fix from the network"],
                ["Rate: Worked / Didn't Work", "After community fix applied", "Rate fix quality (improves network)"],
                ["Approve & Merge", "Draft PR message", "Approve and merge the AI-generated fix"],
                ["Cancel", "Draft PR message", "Cancel in-progress remediation"],
                ["Retry", "Failed remediation", "Retry remediation with a fresh attempt"],
                ["Generate Postmortem", "Incident storm", "Generate AI postmortem for the incident"],
              ]}
            />

            <SectionHeading id="slack-fix">Slack Bot — Fix from Slack</SectionHeading>
            <P>
              When an alert appears in Slack, click <strong>Fix It</strong> to trigger the full AI remediation pipeline.
              Progress updates appear as thread replies in real-time:
            </P>
            <StepList steps={[
              { title: "Analyzing repository", body: "The AI connects to your GitHub repo and reads the codebase." },
              { title: "Diagnosing root cause", body: "AI analyzes the error with context from Sentry, Vercel, Substrate recordings, and past fixes." },
              { title: "Generating fix", body: "Code changes are generated and pushed to a new branch." },
              { title: "Security scan", body: "3-layer security scan: 17 ESLint rules (eslint-plugin-security), 19 pattern detectors (SSRF, prototype pollution, hardcoded secrets, SQL injection, XSS, open redirect, etc.), and AI security review. HIGH findings block auto-merge." },
              { title: "Self-review", body: "A second AI call reviews the fix like a senior engineer — score, concerns, recommendation." },
              { title: "Waiting for CI", body: "The bot waits for GitHub Actions to pass (retries up to 3 times on failure)." },
              { title: "PR created", body: <>A PR appears in the thread with confidence score and EAP verification. Click <strong>Approve &amp; Merge</strong> to merge from Slack.</> },
            ]} />
            <P>
              If Substrate is enabled, the recording (HTTP calls, DB queries, file operations) is automatically attached to the thread.
            </P>

            <SectionHeading id="slack-ai">Slack Bot — Ask Inari</SectionHeading>
            <P>
              Mention <InlineCode>@InariWatch</InlineCode> in any channel or send a DM to ask questions about your errors:
            </P>
            <CodeBlock label="Examples">{`@InariWatch what broke today?
@InariWatch why does the payment endpoint fail on Fridays?
@InariWatch summarize this week's incidents`}</CodeBlock>
            <P>
              If you ask in an alert thread, the AI automatically includes that alert{"'"}s full context (stack trace, AI diagnosis, remediation history).
              Responses use your BYOK AI key from Settings.
            </P>

            <SectionHeading id="slack-oncall">Slack Bot — On-Call in Slack</SectionHeading>
            <P>
              When a critical alert arrives, the bot automatically tags the on-call engineer in the thread.
              Use <InlineCode>/inariwatch oncall</InlineCode> to see rotations and <InlineCode>/inariwatch oncall swap @user</InlineCode> to hand off.
            </P>

            <SectionHeading id="slack-deploys">Slack Bot — Deploy Monitoring</SectionHeading>
            <P>
              When a Vercel deploy succeeds, the bot posts a notification and monitors error rates for 15 minutes.
              After the monitoring window, it posts a follow-up: healthy or unhealthy with error count.
            </P>

            {/* ────────────────────────────────────────────────────────────────
                TELEGRAM BOT
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="telegram-setup">Telegram Bot — Setup</SectionHeading>
            <P>
              The InariWatch Telegram bot has full parity with Slack — 15 commands, 13 inline button callbacks,
              auto-delivery of alerts with AI diagnosis, and all remediation workflows.
            </P>
            <StepList steps={[
              { title: "Create a Telegram bot", body: <>Open Telegram → search <strong>@BotFather</strong> → <InlineCode>/newbot</InlineCode>. Copy the token.</> },
              { title: "Connect in Settings", body: "Go to Settings → Notification channels → Telegram. Paste the bot token." },
              { title: "Link your account", body: <>Send <InlineCode>/link your@email.com</InlineCode> to the bot to connect your Telegram to InariWatch.</> },
              { title: "Set webhook", body: <>The webhook URL is <InlineCode>https://app.inariwatch.com/api/telegram/webhook</InlineCode>. Set <InlineCode>TELEGRAM_WEBHOOK_SECRET</InlineCode> in your env.</> },
            ]} />

            <SubHeading id="telegram-commands">Commands (15)</SubHeading>
            <Table
              head={["Command", "Description"]}
              rows={[
                ["/status", "Open alert count, critical alerts, who is on-call"],
                ["/alerts [severity]", "List alerts with optional filter (critical, warning, info)"],
                ["/fix_ALERTID", "Trigger AI remediation for an alert"],
                ["/oncall", "Show current on-call rotation"],
                ["/oncall swap EMAIL", "Create a 24-hour on-call override"],
                ["/trends [days]", "Error trends: top errors, period comparison"],
                ["/ask QUESTION", "Ask Inari AI about your infrastructure"],
                ["/uptime", "Check all uptime monitors"],
                ["/rollback PROJECT", "Rollback to previous deploy on any supported host (Vercel, Netlify, CF Pages, Render)"],
                ["/maintenance PROJECT MINS", "Create a maintenance window"],
                ["/maintenance list", "Show active maintenance windows"],
                ["/search ERROR", "Search community fix network"],
                ["/integrations", "Integration health check"],
                ["/link EMAIL", "Link your Telegram to InariWatch"],
                ["/help", "Show all commands"],
              ]}
            />

            <SubHeading id="telegram-actions">Button Actions (10)</SubHeading>
            <P>Inline buttons appear on alert messages and remediation updates:</P>
            <Table
              head={["Button", "What it does"]}
              rows={[
                ["Ack", "Acknowledge alert"],
                ["Resolve", "Resolve alert"],
                ["Reopen", "Reopen resolved alert"],
                ["Fix", "Trigger AI remediation"],
                ["Apply Fix", "Apply community fix"],
                ["Worked / Didn't Work", "Rate community fix quality"],
                ["Approve & Merge", "Approve AI-generated PR"],
                ["Cancel", "Cancel in-progress remediation"],
                ["Retry", "Retry failed remediation"],
                ["Generate Postmortem", "AI postmortem for incidents"],
              ]}
            />

            <SubHeading id="telegram-auto">Auto-Delivery</SubHeading>
            <P>
              These messages are sent automatically — no command needed:
            </P>
            <Table
              head={["Feature", "What it sends"]}
              rows={[
                ["Alert push", "New alerts with AI diagnosis + Ack/Resolve/Fix buttons"],
                ["Substrate recording", "I/O recording attached 5s after alert (HTTP calls, DB queries)"],
                ["Community fix suggest", "Known fix with success rate + Apply/Rate buttons"],
                ["On-call tagging", "DM to on-call engineer on critical alerts"],
                ["Incident storms", "Grouped notification + Generate Postmortem button"],
                ["Deploy notifications", "Success/failure + 15-min health follow-up"],
                ["Shadow replay", "Execution replay risk score"],
                ["PR predictions", "Pre-deploy risk warning with View PR link"],
                ["EAP verification", "Cryptographic verification chain display"],
                ["Weekly digest", "Stats, top alerts, AI summary via cron"],
                ["Remediation progress", "Step-by-step updates as replies"],
              ]}
            />

            <div className="rounded-lg border border-blue-900/30 bg-blue-950/20 px-4 py-3 text-sm">
              <strong>Full parity with Slack.</strong> Every feature available in the Slack bot is also available
              in Telegram — same commands, same buttons, same auto-delivery. Choose whichever your team prefers.
            </div>

            {/* ────────────────────────────────────────────────────────────────
                INARIWATCH BOT (MOBILE)
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="bot-overview">InariWatch Bot — Overview</SectionHeading>
            <P>
              InariWatch Bot is the native mobile app — your 4th notification channel alongside Slack, Telegram, and the web dashboard.
              Unlike Slack/Telegram, it has zero third-party limitations: full alert bodies, colored diffs, substrate I/O recordings, and native push notifications 24/7.
            </P>
            <Table
              head={["Feature", "Slack/Telegram", "InariWatch Bot"]}
              rows={[
                ["Alert body", "Truncated (3000 chars)", "Full — no limit"],
                ["AI diagnosis", "Truncated", "Full — no limit"],
                ["Code diffs", "Monospace plain text", "Colored (green/red)"],
                ["Substrate I/O", "Summary only", "Full event browser"],
                ["Push notifications", "Via third-party app", "Native iOS/Android"],
                ["Quick actions", "Inline buttons", "Swipe gestures + buttons"],
              ]}
            />

            <SubHeading id="bot-install">Install</SubHeading>
            <p className="mb-3">
              <a href="/download" className="text-inari-accent underline font-medium">Download InariWatch Bot →</a>
            </p>
            <Table
              head={["Platform", "How to install"]}
              rows={[
                ["Android", "Download APK from app.inariwatch.com/download — enable \"Install from unknown sources\""],
                ["iOS", "Join TestFlight from app.inariwatch.com/download — tap \"Join\""],
              ]}
            />
            <P>
              On first launch, tap <strong>Sign in with InariWatch</strong>. The browser opens for authentication —
              approve and the app is ready. Push notifications register automatically.
            </P>

            <SubHeading id="bot-screens">Screens (5)</SubHeading>
            <Table
              head={["Screen", "What it does"]}
              rows={[
                ["Feed", "Real-time alert list (10s polling). Filter by severity. Swipe right to ack, left to resolve. Tap for detail."],
                ["Alert Detail", "Full body + AI diagnosis + Substrate I/O recording + Community fix (with success rate) + Remediation history. Actions: Ack, Resolve, Fix It."],
                ["Fix Progress", "Live remediation timeline (3s polling). Steps: analyzing → reading code → generating → CI → PR. Approve, cancel, or retry."],
                ["Ask Inari", "Chat with AI about your infrastructure. Full context: alerts, remediations, integrations, uptime. Example questions to tap."],
                ["Status", "Uptime monitors (green/red), on-call rotation, alert count, error trends (7 days)."],
              ]}
            />

            <SubHeading id="bot-push">Push Notifications</SubHeading>
            <P>
              Push notifications use Expo Push Service → FCM (Android) / APNs (iOS).
              They work 24/7, even when the app is closed.
            </P>
            <Table
              head={["Severity", "Behavior"]}
              rows={[
                ["Critical", "High priority push with urgent sound + vibration"],
                ["Warning", "Normal push with default sound"],
                ["Info", "Silent push (badge update only)"],
              ]}
            />
            <P>
              Tapping a push notification opens the alert detail directly (deep link).
              Configure which severities trigger push in <strong>Settings → Notification channels</strong> on the web dashboard.
            </P>

            <div className="rounded-lg border border-blue-900/30 bg-blue-950/20 px-4 py-3 text-sm">
              <strong>Same service layer.</strong> InariWatch Bot calls the same 17 MCP tools and service layer as Slack, Telegram, and the dashboard.
              A fix triggered from the mobile app appears in Slack. An alert resolved in Telegram disappears from the mobile feed.
            </div>

            {/* ────────────────────────────────────────────────────────────────
                VS CODE EXTENSION
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="vscode-setup">VS Code Extension — Setup</SectionHeading>
            <P>
              The InariWatch VS Code extension shows errors inline in your editor with AI diagnosis on hover.
              No need to open a dashboard — errors appear as squiggly lines right where the code is.
            </P>
            <StepList steps={[
              { title: "Install the extension", body: <>Search for <strong>InariWatch</strong> in the VS Code marketplace, or install from the command line: <InlineCode>code --install-extension inariwatch.inariwatch</InlineCode></> },
              { title: "Sign in", body: <>Open the command palette and run <InlineCode>InariWatch: Sign In</InlineCode>. Paste your API token from Settings → API Keys.</> },
              { title: "Alerts appear", body: "Unresolved alerts from your projects appear as inline diagnostics, in the sidebar, and in the status bar." },
            ]} />

            <SectionHeading id="vscode-features">VS Code Extension — Features</SectionHeading>
            <Table
              head={["Feature", "Description"]}
              rows={[
                ["Inline diagnostics", "Error locations from stack traces appear as squiggly lines in your editor"],
                ["Sidebar panel", "TreeView showing all alerts grouped by file with severity icons"],
                ["Hover diagnosis", "Hover over an error line to see the AI diagnosis in a tooltip"],
                ["Status bar", "Unread alert count in the bottom status bar, click to open sidebar"],
                ["Mark read / Resolve", "Right-click an alert in the sidebar to mark as read or resolve"],
                ["Open in dashboard", "Jump to the full alert detail in your browser"],
              ]}
            />
            <P>
              The extension polls the InariWatch API every 30 seconds (configurable) and supports real-time updates via SSE.
            </P>

            <SectionHeading id="vscode-local">VS Code Extension — Local Mode</SectionHeading>
            <P>
              The extension can work without a cloud account. Set <InlineCode>inariwatch.mode</InlineCode> to <InlineCode>local</InlineCode> in VS Code settings.
              It runs a local server on port 9222 that receives errors directly from the capture SDK.
            </P>
            <CodeBlock label="Capture SDK → VS Code (local)">{`# Set your app's DSN to the local extension server
INARIWATCH_DSN=http://localhost:9222/ingest`}</CodeBlock>
            <P>
              Errors appear instantly in your editor. No account, no cloud, no signup.
            </P>

            {/* ────────────────────────────────────────────────────────────────
                NOTIFICATIONS
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="notif-telegram">Notifications — Telegram</SectionHeading>
            <P>
              The Telegram bot has full parity with Slack — 15 commands, 13 inline button callbacks,
              auto-delivery with AI diagnosis, and all remediation workflows.
              See the <a href="#telegram-setup" className="text-inari-accent underline">Telegram Bot</a> section above for the complete setup and feature guide.
            </P>

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
                ANALYTICS
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="analytics-overview">Analytics</SectionHeading>
            <P>
              The Analytics page (<InlineCode>/analytics</InlineCode>) gives you a 14-day view of alert trends and a 30-day
              view of AI remediation performance. All metrics update in real time as alerts arrive and fixes are approved.
            </P>
            <Table
              head={["Section", "Window", "What it shows"]}
              rows={[
                ["Alert trends", "14 days", "Alerts per day (stacked by severity), by source, by severity distribution"],
                ["AI Remediation", "30 days", "Approval rate, avg confidence, avg decide time, auto-merge count, post-deploy success"],
                ["Response time comparison", "30 days", "Human MTTR vs AI MTTR side by side"],
                ["Cost savings", "30 days", "Estimated engineering cost recovered based on time saved"],
              ]}
            />

            <SubHeading id="analytics-mttr">MTTR comparison</SubHeading>
            <P>
              InariWatch tracks two resolution times separately:
            </P>
            <Table
              head={["Metric", "Definition"]}
              rows={[
                ["Human MTTR", "Average time from alert created to resolved for alerts fixed manually (no AI remediation session)"],
                ["AI MTTR", "Average time from alert created to resolved for alerts fixed via an approved AI remediation session"],
              ]}
            />
            <P>
              When AI MTTR is at least 2× faster than human MTTR, a speedup banner appears:
              {' '}<em>{"\""}AI resolves incidents 15× faster than manual review.{"\"" }</em>
            </P>
            <Callout type="info">
              MTTR data starts populating as soon as alerts are resolved. Alerts resolved before upgrading to this version
              do not have a <InlineCode>resolved_at</InlineCode> timestamp and are not included in the calculation.
            </Callout>

            <SubHeading id="analytics-roi">Cost savings</SubHeading>
            <P>
              InariWatch estimates the engineering cost recovered by AI remediation using a simple formula:
            </P>
            <CodeBlock label="Formula">{`hours_saved  = ai_resolved_alerts × (human_mttr − ai_mttr) / 3600
cost_saved   = hours_saved × $150 / hr`}</CodeBlock>
            <P>
              The <InlineCode>$150/hr</InlineCode> rate is a conservative industry average for senior engineering time.
              The card appears in the Response time comparison section and only renders when there is enough data
              to show a meaningful difference.
            </P>

            <SubHeading id="analytics-ai">AI Remediation stats</SubHeading>
            <Table
              head={["Metric", "Definition"]}
              rows={[
                ["Remediations", "Total AI fix sessions started in the last 30 days"],
                ["Approval rate", "% of sessions approved (status = completed)"],
                ["Avg confidence", "Mean AI confidence score (0–100) across all sessions"],
                ["Avg decide time", "Mean time from fix proposed to human approval"],
                ["Auto-merged", "Sessions merged without a human click (autonomous mode)"],
                ["Post-deploy", "% of merged fixes that passed the 10-min monitoring window"],
                ["Reverted", "Fixes auto-reverted after a regression was detected post-merge"],
                ["Cancelled", "Sessions rejected by the developer"],
              ]}
            />

            {/* ────────────────────────────────────────────────────────────────
                WEEKLY DIGEST
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="notif-digest">Weekly Digest</SectionHeading>
            <P>
              Every Monday InariWatch sends a weekly summary to all active notification channels — email
              and Slack. The digest covers the last 7 days and includes an optional AI-generated commentary
              if you have an AI key configured.
            </P>

            <SubHeading id="notif-digest-contents">What&apos;s included</SubHeading>
            <Table
              head={["Field", "Description"]}
              rows={[
                ["Total alerts",    "Count of all alerts received in the last 7 days"],
                ["Critical",        "Alerts with severity = critical"],
                ["Resolved",        "Alerts marked as resolved"],
                ["Open",            "Alerts still unresolved at send time"],
                ["Top 5 alerts",    "Most critical recent alerts, sorted by severity then time"],
                ["AI summary",      "2–3 sentence narrative generated by your configured AI key (optional)"],
              ]}
            />

            <SubHeading id="notif-digest-channels">Delivery channels</SubHeading>
            <P>
              The digest is sent to every verified email channel and every active Slack channel mapping
              on your account. A user with both email and Slack configured receives both.
              Users with no alerts in the past 7 days are skipped.
            </P>
            <Callout type="tip">
              The digest is sent by an external cron via cron-job.org every Monday at 08:00 UTC.
              You can trigger it manually with <InlineCode>GET /api/cron/digest</InlineCode> using
              your <InlineCode>CRON_SECRET</InlineCode> header.
            </Callout>

            {/* ────────────────────────────────────────────────────────────────
                CODE INTELLIGENCE
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="code-intel-overview">Code Intelligence</SectionHeading>
            <P>
              Code Intelligence is InariWatch{"'"}s built-in Code RAG system. It indexes your entire codebase so the AI
              understands your conventions, patterns, and architecture — generating fixes that look like they were written
              by someone on your team, not a stranger.
            </P>
            <P>
              The system combines <strong>tree-sitter AST parsing</strong>, <strong>Voyage Code 3 embeddings</strong>,
              {" "}<strong>hybrid search (vector + BM25)</strong>, and a <strong>dependency graph</strong> to give the AI
              deep understanding of your code.
            </P>

            <Table
              head={["Capability", "What it does", "Status"]}
              rows={[
                ["Codebase Indexing", "Parse every function, class, and type in your repo via tree-sitter AST", "Automatic"],
                ["Hybrid Search", "Vector similarity + full-text search with AI re-ranking", "Automatic"],
                ["Dependency Graph", "Knows who calls what — if you change function A, it knows B and C are affected", "Automatic"],
                ["Fix Replay", "Embeds past successful fixes — \"this was fixed 3 times, here's what worked\"", "Automatic"],
                ["Regression Tests", "AI generates tests that reproduce the bug and verify the fix", "Automatic"],
                ["Substrate Replay", "Verifies fix against recorded I/O that caused the crash", "When Substrate active"],
                ["E2E Staging", "Spins up staging via GitHub Actions and runs Playwright tests against the fix", "When E2E detected"],
              ]}
            />

            <Callout type="info">
              Code Intelligence activates automatically when you connect a GitHub integration. No configuration needed —
              it detects your language, framework, and test setup.
            </Callout>

            <SubHeading id="code-intel-indexing">Codebase Indexing</SubHeading>
            <P>
              When you connect GitHub, InariWatch automatically indexes your repository. The pipeline:
            </P>
            <StepList steps={[
              {
                title: "Fetch repo files via GitHub API",
                body: <>Respects blocklists — skips <InlineCode>.env</InlineCode>, <InlineCode>node_modules</InlineCode>, lock files, binaries, build output.</>
              },
              {
                title: "Parse AST with tree-sitter WASM",
                body: <>Extracts every function, class, method, type, and interface with precise line numbers. Supports TypeScript, JavaScript, Python, Go, Rust, and Java.</>
              },
              {
                title: "Generate docstrings with AI",
                body: <>GPT-4o-mini generates natural language descriptions for each code chunk in batches of 15. These descriptions power the semantic search.</>
              },
              {
                title: "Generate embeddings",
                body: <>Voyage Code 3 (primary) or OpenAI text-embedding-3-small (fallback) creates 1024-dimensional vectors for each chunk. Stored in pgvector with HNSW index.</>
              },
              {
                title: "Build dependency graph",
                body: <>From the AST, extracts which functions call which, what imports each file has. Stored as edges in <InlineCode>code_dependencies</InlineCode>.</>
              },
            ]} />

            <P>
              <strong>Incremental indexing:</strong> After the first full index, subsequent pushes only re-index changed
              files (via <InlineCode>git diff</InlineCode>). Rate limited to 1 re-index per repo per 5 minutes.
            </P>

            <SubHeading id="code-intel-search">Hybrid Search</SubHeading>
            <P>
              When the AI needs to find relevant code (during remediation or via the <InlineCode>search_codebase</InlineCode> MCP tool),
              it uses a three-stage retrieval pipeline:
            </P>

            <Table
              head={["Stage", "Method", "What it does"]}
              rows={[
                ["1. Vector search", "pgvector cosine similarity", "Finds semantically similar code using Voyage Code 3 embeddings of docstrings"],
                ["2. Keyword search", "PostgreSQL tsvector (BM25)", "Finds exact matches on function names, variable names, error messages via full-text search"],
                ["3. RRF Fusion", "Reciprocal Rank Fusion (k=60)", "Combines both result sets — chunks that appear in both get boosted"],
                ["4. AI Re-ranking", "GPT-4o-mini", "From top 50 fused results, AI selects the 5-10 most relevant for the specific error"],
                ["5. Graph enrichment", "Dependency graph", "For each result, attaches callers (who calls it) and callees (what it calls)"],
              ]}
            />

            <P>
              The final context (up to 8,000 tokens) is injected into both the diagnosis and fix generation prompts
              with the instruction: <em>{'"'}your fix MUST follow these patterns.{'"'}</em>
            </P>

            <SubHeading id="code-intel-embeddings">Embeddings — Voyage Code 3</SubHeading>
            <P>
              InariWatch uses <strong>Voyage Code 3</strong> as the primary embedding model for code — it achieves
              12-15% better similarity on code retrieval benchmarks compared to OpenAI{"'"}s text-embedding-3-small.
            </P>

            <Table
              head={["Feature", "Voyage Code 3", "OpenAI (fallback)"]}
              rows={[
                ["Dimensions", "1024", "1024 (truncated from 1536)"],
                ["Input types", "document / query (asymmetric)", "Single type"],
                ["Code optimized", "Yes — trained on code retrieval", "General purpose"],
                ["Detection", "API key starts with pa-", "API key starts with sk-"],
                ["Cost", "~$0.06 / 1M tokens", "~$0.02 / 1M tokens"],
              ]}
            />

            <Callout type="tip">
              Set <InlineCode>VOYAGE_API_KEY</InlineCode> in your environment to use Voyage Code 3.
              If not set, InariWatch falls back to your OpenAI key automatically.
            </Callout>

            <SubHeading id="code-intel-tree-sitter">AST Parsing — Tree-sitter WASM</SubHeading>
            <P>
              InariWatch uses <strong>web-tree-sitter</strong> (WebAssembly) for precise AST parsing.
              Unlike regex-based parsing, tree-sitter understands the actual grammar of each language —
              zero missed functions, correct handling of nested classes, decorators, generics, and macros.
            </P>

            <Table
              head={["Language", "What it extracts"]}
              rows={[
                ["TypeScript / JavaScript", "Functions, arrow functions, classes, methods, types, interfaces, imports"],
                ["Python", "Functions, classes, methods, imports (from/import)"],
                ["Go", "Functions, methods (with receiver), types (struct/interface), imports"],
                ["Rust", "Functions, impl blocks, structs, enums, traits, use declarations"],
                ["Java", "Classes, methods, constructors, interfaces, enums, imports"],
              ]}
            />

            <P>
              If tree-sitter WASM fails to load (rare edge case), a regex-based fallback parser activates automatically.
            </P>

            <SubHeading id="code-intel-fix-replay">Fix Replay</SubHeading>
            <P>
              When a fix completes successfully, InariWatch embeds the entire fix context (diagnosis + files changed + result)
              as a vector. When a similar error arrives later, it searches past fixes by embedding similarity.
            </P>
            <P>
              This means the AI gets context like: <em>{'"'}This function was fixed 3 times before. The first time, the fix was X
              (confidence 85%). The second time, it was Y (confidence 92%).{'"'}</em> — turning past experience into future accuracy.
            </P>

            <Callout type="info">
              Fix Replay builds up automatically over time. The more fixes InariWatch completes for your project,
              the better it gets at fixing similar errors.
            </Callout>

            <SubHeading id="code-intel-test-gen">Regression Test Generation</SubHeading>
            <P>
              After generating a fix, the AI also generates 1-3 regression tests that:
            </P>
            <StepList steps={[
              {
                title: "Reproduce the bug",
                body: <>Creates a test case with the exact input that causes the crash.</>
              },
              {
                title: "Verify the fix",
                body: <>Asserts that with the fix applied, the same input no longer crashes.</>
              },
              {
                title: "Follow your conventions",
                body: <>Reads up to 3 existing test files from your repo to learn your framework (vitest, jest, pytest, go test), assertion style, and file structure.</>
              },
            ]} />
            <P>
              The test files are pushed alongside the fix. Your CI runs them automatically.
              If the regression test fails, the fix is bad — InariWatch retries with a different approach.
            </P>

            <SubHeading id="code-intel-substrate-replay">Substrate Replay Verification</SubHeading>
            <P>
              If your app uses <InlineCode>@inariwatch/capture</InlineCode> with <InlineCode>substrate: true</InlineCode>,
              InariWatch records all I/O (HTTP requests, DB queries, file operations) before a crash.
              Substrate Replay takes that recording and verifies the fix against it:
            </P>

            <Table
              head={["Mode", "How it works", "When it runs"]}
              rows={[
                ["AI Analysis", "AI reads the I/O recording + fix and predicts if the fix prevents the crash", "Always (when recording exists)"],
                ["GitHub Action Replay", "Generates a workflow that replays the recorded HTTP requests against the fixed app", "Optional (generates workflow file)"],
              ]}
            />

            <P>
              The AI Analysis produces a <strong>risk score (0-100)</strong>. If the score is {"<="} 40, the
              {" "}<InlineCode>substrate_replay</InlineCode> gate passes. This is an optional gate — if no
              Substrate recording exists, it{"'"}s skipped.
            </P>

            <SubHeading id="code-intel-e2e">E2E Staging Verification</SubHeading>
            <P>
              InariWatch auto-detects your E2E test framework (Playwright, Cypress) and generates a GitHub Actions
              workflow that builds the app with the fix, starts it, and runs your E2E tests against it.
            </P>
            <StepList steps={[
              {
                title: "Detect framework",
                body: <>Reads <InlineCode>package.json</InlineCode> to find Playwright, Cypress, or other E2E frameworks. Detects Next.js, Express, etc.</>
              },
              {
                title: "Generate workflow",
                body: <>Creates <InlineCode>.github/workflows/inariwatch-e2e-staging.yml</InlineCode> tailored to your stack.</>
              },
              {
                title: "Push and wait",
                body: <>Pushes the workflow to the fix branch. GitHub Actions runs it automatically. InariWatch polls every 20 seconds for results (max 10 min).</>
              },
              {
                title: "Gate evaluation",
                body: <>If E2E tests pass, the <InlineCode>e2e_staging</InlineCode> gate passes. If they fail, the fix likely introduces regressions.</>
              },
            ]} />

            <Callout type="tip">
              E2E staging uses your existing GitHub Actions minutes — zero additional cost.
              If no E2E framework is detected in your project, this step is skipped automatically.
            </Callout>

            <SubHeading id="code-intel-gates">Safety Gates (11)</SubHeading>
            <P>
              Every fix must pass through 11 safety gates before auto-merge. All gates are data-driven — no guessing.
            </P>

            <Table
              head={["#", "Gate", "Pass condition", "Required"]}
              rows={[
                ["0", "auto_merge_enabled", "Enabled in project settings", "Yes"],
                ["1", "ci_passed", "All CI checks pass (including regression tests)", "Yes"],
                ["2", "confidence", "AI diagnosis confidence >= configured threshold", "Yes"],
                ["3", "lines_changed", "Total lines changed <= configured max", "Yes"],
                ["4", "self_review", "AI self-review score >= 70, not rejected", "If enabled"],
                ["5", "substrate_simulate", "Substrate simulate risk score <= 40", "If recording exists"],
                ["6", "eap_chain_verified", "EAP cryptographic proof chain verified", "If receipt exists"],
                ["7", "prediction_safe", "Prediction engine risk score <= 40", "If prediction ran"],
                ["8", "security_scan", "0 HIGH severity findings (17 ESLint rules + 19 patterns + AI review)", "If scan ran"],
                ["9", "substrate_replay", "Substrate I/O replay confirms fix prevents crash", "If recording exists"],
                ["10", "e2e_staging", "E2E staging tests pass in GitHub Actions", "If E2E framework detected"],
              ]}
            />

            <P>
              If all gates pass → <strong>auto-merge</strong>. If any gate fails → <strong>draft PR</strong> for human review.
              Optional gates (5-10) only activate when their data is available — they never block if there{"'"}s nothing to check.
            </P>

            {/* ────────────────────────────────────────────────────────────────
                SESSION REPLAY
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="replay-overview">Session Replay</SectionHeading>
            <P>
              Watch any user session — DOM playback, console, network, navigation, Web Vitals,
              and frustration signals on a single timeline — then click <strong>Generate Fix</strong>{" "}
              to open a PR. Replay is workspace-scoped: enabled per organization, invisible to
              personal workspaces.
            </P>
            <P>
              Lives at <InlineCode>/sessions</InlineCode> (list) and{" "}
              <InlineCode>/sessions/[sessionId]</InlineCode> (player). Storage on Cloudflare R2.
              Replays with errors auto-correlate to alerts (or create one) so the Generate Fix
              button is wired the moment a session lands.
            </P>

            <SubHeading id="replay-install">Install the SDK</SubHeading>
            <P>
              Replay ships as a separate package from <InlineCode>@inariwatch/capture</InlineCode>.
              It only loads in the browser — no server bundle impact.
            </P>
            <CodeBlock label="Install">{`npm install @inariwatch/capture-replay`}</CodeBlock>
            <CodeBlock label="Initialize (browser entry / _app.tsx / root layout)">{`import { initReplay } from "@inariwatch/capture-replay";

initReplay({
  projectId: "your-project-id",
  // optional — defaults are sensible
  sampleRate: 1.0,           // record every session
  maskAllInputs: true,       // off only if you know what you're doing
});`}</CodeBlock>
            <Callout type="info">
              You don&apos;t need to invoke a recorder manually. <InlineCode>initReplay()</InlineCode> attaches
              automatically on page load and starts a new session per page-view.
            </Callout>

            <SubHeading id="replay-user">Identify the user</SubHeading>
            <P>
              Replay never scrapes the DOM for emails — you set the user contract explicitly via a
              global. First-write-wins: once the session has identified the user, later writes are
              ignored to prevent collision under SPA navs.
            </P>
            <CodeBlock label="After your auth resolves">{`window.__INARIWATCH_USER__ = {
  id:    user.id,           // optional but recommended
  email: user.email,        // optional — masked per project setting
};`}</CodeBlock>
            <P>
              Both fields are optional. If the project has{" "}
              <InlineCode>hashEndUserEmails: true</InlineCode>, the SDK still sends the raw email
              and the server hashes it before persistence — your filters search via the hash, never
              the plaintext.
            </P>

            <SubHeading id="replay-privacy">Privacy & PII masking</SubHeading>
            <P>
              Inputs (<InlineCode>&lt;input&gt;</InlineCode>, <InlineCode>&lt;textarea&gt;</InlineCode>),
              passwords, and elements with the <InlineCode>data-inari-block</InlineCode> attribute are
              masked before they ever leave the browser. The PII classifier also redacts emails,
              tokens, and credit-card-shaped strings from console logs.
            </P>
            <Table
              head={["Surface", "Default", "How to override"]}
              rows={[
                ["Inputs", "masked", "maskAllInputs: false in initReplay()"],
                ["Specific elements", "visible", "Add data-inari-block attribute to mask"],
                ["Console payloads", "PII-classified", "Server-side redaction always on"],
                ["Network bodies", "not captured", "Body capture deferred — PII risk"],
                ["End-user email", "stored plaintext", "Per-project hashEndUserEmails setting"],
              ]}
            />

            <SubHeading id="replay-vitals">Web Vitals</SubHeading>
            <P>
              LCP, CLS, INP, FCP, and TTFB are captured via <InlineCode>PerformanceObserver</InlineCode>{" "}
              (no <InlineCode>web-vitals</InlineCode> dependency). Vitals flush on{" "}
              <InlineCode>visibilitychange</InlineCode> and <InlineCode>pagehide</InlineCode> so they
              survive tab close. The player shows the worst-rated metric as a header chip; the list
              card shows a single &ldquo;worst vital&rdquo; badge.
            </P>
            <P>
              Vitals also feed the AI summary prompt — &ldquo;LCP slow&rdquo; in the explanation
              comes straight from the snapshot.
            </P>

            <SubHeading id="replay-frustration">Rage + dead-click detection</SubHeading>
            <P>
              Detected server-side from the captured event stream — no extra SDK wiring.
            </P>
            <Table
              head={["Signal", "Detection", "Score weight"]}
              rows={[
                ["Rage clicks", "≥ 3 clicks within 1000ms on the same target", "× 3"],
                ["Dead clicks", "Click followed by < 5 DOM mutations within 3000ms and no nav", "× 1"],
              ]}
            />
            <P>
              <InlineCode>frustrationScore = rage × 3 + dead × 1</InlineCode>. Sessions with
              non-zero scores get an amber badge in the list. Filter by{" "}
              <InlineCode>?hasRageClicks=1</InlineCode> or{" "}
              <InlineCode>?hasDeadClicks=1</InlineCode> on the URL.
            </P>

            <SubHeading id="replay-generate-fix">Generate Fix from a replay</SubHeading>
            <P>
              When a replay contains an error, ingest auto-correlates it with an existing alert
              (matched by error fingerprint) — or synthesizes a new alert at severity{" "}
              <InlineCode>warning</InlineCode>. The Generate Fix button in the player triggers the
              full remediation pipeline: diagnose → read code → write fix → 11 safety gates →
              PR → auto-merge if every gate passes.
            </P>
            <Callout type="warn">
              Replays ingested before Phase H (2026-04-15) have <InlineCode>alertId = null</InlineCode>{" "}
              and won&apos;t back-fill automatically. Record a new session with an error to test the
              flow, or run a backfill script over <InlineCode>replay_sessions</InlineCode>.
            </Callout>

            <SubHeading id="replay-settings">Per-project settings</SubHeading>
            <P>
              Configure per project at <InlineCode>/projects/[slug]</InlineCode> → Replay tab. The
              settings UI merges patches on save — partial updates won&apos;t wipe other fields.
            </P>
            <Table
              head={["Setting", "Default", "Notes"]}
              rows={[
                ["enabled", "false", "Per-project kill switch (also gated by REPLAY_V2_ORGS env)"],
                ["sampleRate", "1.0", "0.0–1.0 — fraction of sessions recorded"],
                ["maskAllInputs", "true", "Set to false at your own risk"],
                ["hashEndUserEmails", "false", "When true, email filters use SHA-256 exact match"],
                ["retentionDays", "30", "1–366 — daily cron sweeps expired sessions from R2 + DB"],
              ]}
            />
            <SubHeading id="replay-cors">CORS</SubHeading>
            <P>
              The ingest endpoint is per-project, with an allowlist of origins configured in the
              project settings. Default is empty — add your production and staging origins
              before going live, or replays will be CORS-rejected.
            </P>

            <SubHeading id="replay-retention">Retention</SubHeading>
            <P>
              A daily cron <InlineCode>/api/cron/replay-retention</InlineCode> sweeps sessions
              older than each project&apos;s <InlineCode>retentionDays</InlineCode>. 200 sessions
              per run, 1-day grace floor, 366-day absolute max. R2 objects and DB rows are deleted
              together — replays don&apos;t leave orphaned blobs.
            </P>

            {/* ────────────────────────────────────────────────────────────────
                MCP SERVER
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="mcp-overview">MCP Server</SectionHeading>
            <p>
              Connect any AI coding tool to InariWatch via the{" "}
              <strong>Model Context Protocol (MCP)</strong>. Your AI gets real-time access
              to production alerts, root cause analysis, community fixes, and remediation
              — all from inside your editor.
            </p>
            <p className="mt-2">
              Works with Claude Code, Cursor, Windsurf, VS Code Copilot, Codex CLI, Gemini CLI,
              and any tool that supports MCP over HTTP.
            </p>

            <SubHeading id="mcp-setup">Setup</SubHeading>
            <p className="font-medium">Option A — One command (recommended)</p>
            <CodeBlock label="Auto-detect & configure">{`npx @inariwatch/mcp init`}</CodeBlock>
            <p className="mt-1 text-sm text-fg-base">
              Detects installed AI tools, opens the browser to authenticate, and writes config files automatically.
              Pass <code>--token inari_xxxxx</code> to skip browser auth.
            </p>

            <p className="mt-4 font-medium">Option B — Manual setup</p>
            <p>
              1. Go to <strong>Settings &rarr; MCP</strong> and create an access token (choose scope: read, write, or full access).<br />
              2. Add to your AI tool:
            </p>

            <Table
              head={["Tool", "Config"]}
              rows={[
                ["Claude Code", "claude mcp add inariwatch https://mcp.inariwatch.com --transport http -H \"Authorization: Bearer <token>\""],
                ["Cursor / Windsurf", ".cursor/mcp.json → { mcpServers: { inariwatch: { url, headers } } }"],
                ["VS Code Copilot", ".vscode/mcp.json → { servers: { inariwatch: { url, headers } } }"],
                ["Codex CLI", "codex mcp add inariwatch https://mcp.inariwatch.com --header \"Authorization: Bearer <token>\""],
                ["Gemini CLI", "gemini mcp add inariwatch --url https://mcp.inariwatch.com --header \"Authorization: Bearer <token>\""],
                ["OpenClaw", "openclaw mcp set inariwatch '{\"url\":\"https://mcp.inariwatch.com\",\"transport\":\"streamable-http\",\"headers\":{\"Authorization\":\"Bearer <token>\"}}'"],
              ]}
            />

            <p className="mt-4 font-medium">Option C — OAuth (zero-token setup)</p>
            <p className="text-sm text-fg-base">
              Tools that support OAuth 2.1 can discover InariWatch automatically via{" "}
              <code>https://mcp.inariwatch.com/api/mcp/.well-known/oauth-authorization-server</code>.
              Click &quot;Connect&quot; in your tool, approve in the browser, done. PKCE (S256) enforced.
            </p>

            <SubHeading id="mcp-tools">Tools (25)</SubHeading>
            <p>Once connected, your AI can call these tools:</p>

            <Table
              head={["Tool", "Description", "Scope", "Rate"]}
              rows={[
                ["query_alerts", "List recent alerts by project/severity", "read", "200/min"],
                ["get_status", "Projects, integrations, alert counts", "read", "200/min"],
                ["get_uptime", "Current uptime status for all monitors", "read", "200/min"],
                ["get_build_logs", "Build logs for any host (Vercel, Netlify, Cloudflare Pages)", "read", "200/min"],
                ["get_substrate_context", "I/O recording context for an alert", "read", "200/min"],
                ["get_root_cause", "AI-powered root cause analysis", "read", "30/min"],
                ["assess_risk", "Pre-deploy risk assessment for a PR", "read", "30/min"],
                ["get_postmortem", "Generate or retrieve a post-mortem", "read", "200/min"],
                ["search_community_fixes", "Search community fix network", "read", "30/min"],
                ["trigger_fix", "Start AI remediation pipeline (SSE streaming)", "execute", "5/min"],
                ["rollback_deploy", "Host-agnostic rollback (Vercel, Netlify, CF Pages, Render) ⚠️", "execute", "5/min"],
                ["silence_alert", "Mark alert as read/resolved", "write", "200/min"],
                ["acknowledge_alert", "Mark alert as read (acknowledged)", "write", "200/min"],
                ["reopen_alert", "Reopen a resolved alert", "write", "200/min"],
                ["submit_feedback", "Report if an AI fix worked", "write", "200/min"],
                ["run_check", "Trigger an immediate monitoring check", "execute", "30/min"],
                ["ask_inari", "Ask natural language questions about your infrastructure", "read", "30/min"],
                ["get_error_trends", "Error trends: alerts/day, top recurring errors, period comparison", "read", "200/min"],
                ["create_uptime_monitor", "Create a new uptime monitor for a URL", "execute", "200/min"],
                ["run_health_check", "Full installation health check (capture, integrations, AI key, DB, substrate)", "read", "30/min"],
                ["reproduce_bug", "Replay I/O timeline before a crash (HTTP, DB, file ops) via Substrate recording", "read", "30/min"],
                ["simulate_fix", "AI simulates whether a proposed fix would resolve the bug based on I/O recording", "read", "5/min"],
                ["verify_remediation", "Full verification chain: fix → CI → merge → monitoring → recurrence check", "read", "30/min"],
                ["search_codebase", "Hybrid search (vector + BM25) across indexed codebase with dependency graph", "read", "30/min"],
                ["reindex_codebase", "Trigger incremental re-indexation of a project's codebase", "execute", "30/min"],
              ]}
            />

            <p className="mt-2 text-sm text-fg-base">
              Tools include MCP annotations (<code>readOnlyHint</code>, <code>destructiveHint</code>) so AI clients
              know when to ask for confirmation. <code>rollback_deploy</code> and its legacy alias
              {" "}<code>rollback_vercel</code> are both marked destructive.
            </p>

            <SubHeading id="mcp-resources">Resources (4)</SubHeading>
            <p>
              Resources are live data feeds your AI can read without calling a tool.
              Subscribe for real-time notifications when data changes.
            </p>

            <Table
              head={["URI", "Description"]}
              rows={[
                ["inariwatch://alerts/critical", "Currently open critical alerts across all projects"],
                ["inariwatch://alerts/recent", "Last 20 alerts from the past 24 hours"],
                ["inariwatch://status/overview", "All projects: uptime, alert counts, monitor status"],
                ["inariwatch://remediations/active", "AI remediation sessions currently in progress"],
              ]}
            />

            <p className="mt-2 text-sm text-fg-base">
              Subscribe via <code>resources/subscribe</code>. Receive{" "}
              <code>notifications/resources/updated</code> via the SSE endpoint at{" "}
              <code>GET /api/mcp/events</code> when subscribed resources change (polled every 10s).
            </p>

            <SubHeading id="mcp-prompts">Prompts (7)</SubHeading>
            <p>
              Predefined workflows that appear as commands in your AI tool.
              Each prompt orchestrates multiple tool calls automatically.
            </p>

            <Table
              head={["Prompt", "What it does"]}
              rows={[
                ["diagnose", "Find top critical alert → root cause → substrate context → community fixes → summary"],
                ["status-report", "Full status: uptime, open alerts, active issues"],
                ["fix-this", "Find critical alert → search known fixes → preview AI fix (dry run) → ask before applying"],
                ["post-deploy-check", "After deploy: check uptime, new errors, build logs → health report"],
                ["weekly-summary", "Past 7 days: alert trends, top patterns, system health (5-10 bullet points)"],
                ["production-health-check", "Scheduled: automated hourly health check with action items"],
                ["daily-report", "Scheduled: daily ops report — new alerts, resolved, trends, integration health"],
              ]}
            />

            <SubHeading id="mcp-auth">Auth &amp; scopes</SubHeading>
            <p>
              Tokens are SHA-256 hashed (never stored in plaintext). Choose a scope when creating:
            </p>

            <Table
              head={["Scope", "Access", "Use case"]}
              rows={[
                ["read", "Query tools, resources, prompts", "Dashboards, monitoring, read-only integrations"],
                ["write", "Read + silence alerts, submit feedback", "Team members who triage alerts"],
                ["execute", "Full access: remediation, rollback, checks", "Lead devs, CI/CD pipelines"],
              ]}
            />

            <p className="mt-2 text-sm text-fg-base">
              Tokens can have an expiration date (30d / 90d / 1y / never). Usage stats are visible in{" "}
              <strong>Settings &rarr; MCP usage</strong> (calls/day, top tools, latency, error rate).
              All MCP calls are logged in the audit trail.
            </p>

            <div className="mt-4 rounded-lg border border-blue-900/30 bg-blue-950/20 px-4 py-3 text-sm">
              <strong>Protocol:</strong> Streamable HTTP (JSON-RPC 2.0 over POST), spec version 2024-11-05.
              Capabilities: tools, resources (subscribe), prompts, sampling.
              Endpoint: <code>https://mcp.inariwatch.com</code>.
            </div>

            {/* ────────────────────────────────────────────────────────────────
                PUBLIC APIS
            ──────────────────────────────────────────────────────────────── */}

            <SectionHeading id="api-fix-marketplace">Public API — Fix Marketplace</SectionHeading>
            <P>
              The Fix Marketplace API exposes the community fix database as a public, CORS-open REST API.
              No authentication required. Any tool can query it to look up fixes for known error patterns.
            </P>

            <SubHeading id="api-fix-marketplace-list">List fixes</SubHeading>
            <CodeBlock label="GET /api/community/fixes">{`GET /api/community/fixes
  ?category=runtime_error   # runtime_error | build_error | ci_error | infrastructure | unknown
  &framework=nextjs          # any framework string
  &language=typescript       # any language string
  &min_success_rate=70       # integer 0–100
  &sort=success_rate         # success_rate | occurrences | recent
  &limit=50                  # max 100
  &offset=0                  # pagination`}</CodeBlock>
            <CodeBlock label="Response">{`{
  "fixes": [
    {
      "id": "uuid",
      "successRate": 94,
      "totalApplications": 47,
      "successCount": 44,
      "failureCount": 3,
      "fixApproach": "Wrap the async call in a try/catch and...",
      "fixDescription": "Unhandled promise rejection in middleware",
      "avgConfidence": 87,
      "createdAt": "2025-03-10T12:00:00Z",
      "pattern": {
        "id": "uuid",
        "fingerprint": "abc123",
        "patternText": "UnhandledPromiseRejection...",
        "category": "runtime_error",
        "framework": "nextjs",
        "language": "typescript",
        "occurrenceCount": 312
      }
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0
}`}</CodeBlock>

            <SubHeading id="api-fix-marketplace-detail">Get a single fix</SubHeading>
            <CodeBlock label="GET /api/community/fixes/:id">{`GET /api/community/fixes/uuid-of-fix`}</CodeBlock>
            <P>Returns the same shape as a list item, plus <InlineCode>updatedAt</InlineCode> and full pattern details.</P>

            <SubHeading id="api-fix-marketplace-report">Report outcome</SubHeading>
            <P>
              After applying a fix, report whether it worked. This updates the community success rate so
              future teams benefit from your experience.
            </P>
            <CodeBlock label="POST /api/community/fixes/:id/report">{`POST /api/community/fixes/uuid-of-fix/report
Content-Type: application/json

{ "worked": true }`}</CodeBlock>
            <CodeBlock label="Response">{`{ "ok": true }`}</CodeBlock>
            <Callout type="tip">
              The <InlineCode>successRate</InlineCode> field is recalculated live from
              <InlineCode>successCount / totalApplications</InlineCode>. Reporting helps
              every team that encounters the same pattern.
            </Callout>

            <SectionHeading id="api-status-widget">Public API — Status Widget</SectionHeading>
            <P>
              Embed a live status badge on any website — your landing page, README, or documentation.
              The badge shows current system status, optional uptime percentage, and links to your
              public status page.
            </P>

            <SubHeading id="api-status-widget-embed">Embed code</SubHeading>
            <P>
              Place a <InlineCode>div</InlineCode> with a <InlineCode>data-inariwatch-slug</InlineCode> attribute
              wherever you want the badge to appear, then load the script once.
            </P>
            <CodeBlock label="HTML">{`<div data-inariwatch-slug="your-project-slug"></div>
<script src="https://app.inariwatch.com/embed.js" async></script>`}</CodeBlock>
            <P>
              Alternatively, use the manual config for more control over the target element:
            </P>
            <CodeBlock label="HTML (manual config)">{`<div id="my-status"></div>
<script>
  window.__INARIWATCH__ = {
    slug: "your-project-slug",
    container: "#my-status"
  };
</script>
<script src="https://app.inariwatch.com/embed.js" async></script>`}</CodeBlock>

            <SubHeading id="api-status-widget-appearance">Appearance</SubHeading>
            <Table
              head={["Status", "Color", "Behavior"]}
              rows={[
                ["All Systems Operational", "Green",  "Static badge"],
                ["Degraded Performance",    "Amber",  "Pulsing dot"],
                ["Major Outage",            "Red",    "Pulsing dot"],
              ]}
            />
            <P>
              The badge shows uptime percentage when uptime monitors are configured for the project
              (e.g. <InlineCode>All Systems Operational · 99.8% uptime</InlineCode>).
              Clicking the badge opens the full public status page.
              The widget polls for updates every 60 seconds automatically.
            </P>

            <SubHeading id="api-status-widget-data">Data endpoint</SubHeading>
            <P>The widget fetches from a lightweight CORS-open endpoint you can also use directly:</P>
            <CodeBlock label="GET /api/status/:slug/widget">{`GET /api/status/your-project-slug/widget`}</CodeBlock>
            <CodeBlock label="Response">{`{
  "status":          "operational",
  "label":           "All Systems Operational",
  "uptimePct":       99.8,
  "activeIncidents": 0,
  "slug":            "your-project-slug",
  "pageUrl":         "https://app.inariwatch.com/status/your-project-slug"
}`}</CodeBlock>
            <Callout type="info">
              The endpoint is cached for 60 seconds at the CDN layer
              (<InlineCode>s-maxage=60, stale-while-revalidate=30</InlineCode>).
              Status pages must be set to Public in your project settings to appear.
            </Callout>

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

            <SectionHeading id="ref-stress-tests">Reference — Stress Testing</SectionHeading>
            <P>
              InariWatch infrastructure is validated with a 14-scenario k6 suite (10 load + 4 chaos) that runs against
              the production stack. All scenarios pass.
            </P>
            <Table
              head={["#", "Scenario", "What it validates"]}
              rows={[
                ["1",  "Webhook Storm",         "Capture webhook ingestion under burst load, rate limiting"],
                ["2",  "MCP Rate Limits",       "3 rate limit tiers (cheap 200/min, moderate 30/min, expensive 5/min)"],
                ["3",  "SSE Streaming",         "50 concurrent Server-Sent Event connections, reconnection"],
                ["4",  "Alert Dedup",           "Fingerprinting, deduplication under concurrent writes, storm detection"],
                ["5",  "Auth Brute Force",      "Login rate limiting, device flow poll protection"],
                ["6",  "Cron Fan-out",          "7 sub-pollers in parallel, overlap handling"],
                ["7",  "Neon Saturation",       "DB concurrency: webhooks + MCP + cron simultaneously"],
                ["8",  "Push Serialization",    "Push notification pipeline under critical alert burst"],
                ["9",  "Auto-Heal",             "3 consecutive failures trigger single heal, cooldown, race safety"],
                ["10", "Full Incident",         "End-to-end: deploy fail → error burst → uptime down → auto-heal → verify"],
                ["11", "Chaos · Incident",      "Full incident with mixed valid/malformed payloads + concurrent cron + storm"],
                ["12", "Chaos · MCP Storm",     "200 concurrent MCP calls mixing all 3 rate limit tiers"],
                ["13", "Chaos · Tenant Isolation", "Flood one workspace, verify another's latency stays normal"],
                ["14", "Chaos · SSE",           "50+ SSE connections with random abrupt disconnects"],
              ]}
            />
            <P>
              The stress test suite lives in <InlineCode>k6/</InlineCode> and can be re-run with{" "}
              <InlineCode>bash k6/run-all.sh</InlineCode>. Individual scenarios can be run with{" "}
              <InlineCode>bash k6/run-all.sh webhook-storm</InlineCode>.
            </P>

            {/* Bottom nav */}
            <div className="mt-16 flex items-center justify-between border-t border-line pt-8 text-sm text-fg-base">
              <Link href="/" className="flex items-center gap-1.5 hover:text-fg-strong transition-colors">
                <ChevronRight className="h-3.5 w-3.5 rotate-180" aria-hidden="true" />
                Home
              </Link>
              <Link href="/register" className="flex items-center gap-1.5 text-inari-accent hover:text-inari-accent/80 transition-colors">
                Start free
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>

          </main>
        </div>
      </div>

      {/* Footer — matches landing page */}
      <footer className="border-t border-inari-border py-12">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <Image
                src="/logo-inari/favicon-96x96.png"
                alt=""
                width={24}
                height={24}
              />
              <span className="font-mono text-sm text-fg-base">
                inariwatch · built in MX
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-fg-base">
              <Link href="/docs"    className="hover:text-fg-strong transition-colors">Docs</Link>
              <Link href="/pricing" className="hover:text-fg-strong transition-colors">Pricing</Link>
              <Link href="/download" className="hover:text-fg-strong transition-colors">Mobile</Link>
              <Link href="/trust"   className="hover:text-fg-strong transition-colors">Trust</Link>
              <Link href="/status"  className="hover:text-fg-strong transition-colors">Status</Link>
              <Link href="/blog"    className="hover:text-fg-strong transition-colors">Blog</Link>
              <a
                href="https://github.com/orbita-pos/inariwatch-capture"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-fg-strong transition-colors"
              >
                GitHub
              </a>
              <Link href="/privacy" className="hover:text-fg-strong transition-colors">Privacy</Link>
              <Link href="/terms"   className="hover:text-fg-strong transition-colors">Terms</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
