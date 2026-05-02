# Linear UX Reference

**Provided by Jesús 2026-05-01 as the visual benchmark for Inari Live's S33 UX overhaul.**

These 9 screenshots capture Linear's product UI as of mid-2026. Linear is THE reference for premium dev-tool UX — the closest analogue to what Inari Live should feel like. The S33 executor must mimic the visual patterns shown here without copying assets verbatim (Linear's brand stays Linear's).

## What to extract from each screenshot

### `01-inbox-detail-view.png`
Inbox + detail-pane layout. Three columns: sidebar 240px → list ~340px → detail flex-1.
- Sidebar: monochrome icons + 13px labels + section headers ("Workspace ▾", "Favorites ▾") with disclosure carets
- List rows: avatar (16px) + title bold + meta gray + timestamp far-right
- Detail header: page title 24-28px serif-or-tight-sans + breadcrumbs + action icons in 28×28 hover-bg squares
- `Triage Intelligence` card with status pills `● emil`, `● iOS`, `● Bug` — colored 6px dot prefix + label, semi-transparent bg
- Activity feed: avatar 16px + actor + verb + object + relative timestamp light gray
- Composer bottom: text field + attach + send (filled accent button)

### `02-my-issues-list.png`
Dense issue list. Each row: status icon + ID monospace + status indicator dot + title + status pills right-aligned + assignee avatar + date.
- Row height ~36px — dense, not cramped
- Hover state: bg goes from transparent to `--card`
- Status pills colored by category (purple Reliability, red Bug, green Performance, blue iOS, etc.)

### `03-initiatives-feed.png`
Card feed. Each item: title 16px bold + status pill (`● Project on track`) + author + timestamp + reactions (emoji + count) + comment count.
- Cards stacked with vertical spacing 32px
- Reactions row: small icons with count, all gray
- Section headers: "Today", lighter typography

### `04-initiatives-active-table.png`
Hierarchical table view. Columns: Name, Target, Health, Projects, Active projects, Activity.
- Rows expandable with disclosure triangles
- Health column with `● On track` / `● At risk` / `● Off track` status pills
- Activity column with sparkline-style mini chart (chevrons pointing up = good)
- Indentation for sub-rows (2-level hierarchy visible)

### `05-projects-gantt-timeline.png`
Gantt-style timeline. Months across top (APR, MAY, JUN, JUL, AUG, SEP), projects as horizontal bars below.
- Each bar with milestones (diamond markers + labels)
- Connector lines between dependencies (curved gray lines)
- Month dividers as faint vertical guidelines
- Bar fills semi-transparent with the project's accent color

### `06-issue-detail-right-panel.png`
Issue detail with Linear's "GitHub Copilot" embedded panel on the right.
- Center: issue title + description with code highlight (`vehicle_state` in monospace pill)
- Activity feed: actor + verb + relative time
- Right panel: floating overlay over the detail (250px wide), shadow-lifted, with chat-like messages
- Code references rendered as `monospace pills` inline

### `07-agent-tasks-kanban.png` and `08-agent-tasks-kanban-alt.png`
Kanban board. Three columns (Offline mode, Core Performance, UI Refresh) each with 3-5 cards.
- Column header: icon + name + count
- Card: ID + status pill (Working/Finished) + title + status icon + labels + branch + avatar
- Compact vertical spacing between cards (8px)
- Add card button (`+`) in column header

### `09-agents-insights-charts.png`
Dashboard with stat tiles + charts.
- Top: 3 large stat tiles (3,389 / 1,128 / 729) with label above + huge number below
- Tiles have padding 24px, border `--border`, radius `--radius-lg`
- Chart panel: bar chart with avatars below x-axis (representing assignees)
- Right panel: ranked table (Project / Issues / Cursor / Codex / Copilot)

## Patterns to LOCK as Inari Live design tokens

### Colors — LOCKED to InariWatch web palette (NOT Linear's defaults)

**Inari Live MUST match the existing InariWatch web brand** (extracted from `web/app/globals.css` dark mode). Linear's screenshots are the *layout/density/typography* benchmark, NOT the color benchmark.

Dark mode palette (canonical — matches `web/app/globals.css` lines 33-48):
- `--bg: #0a0a0c` (page background, near-black)
- `--surface: #111114` (card surface, one step up)
- `--card: #16161a` (inner card)
- `--card-elevated: #1a1a1f` (elevated card / modals)
- `--border: #1f1f24` (default border)
- `--border-subtle: #17171b` (ultra-subtle border)
- `--border-strong: #2a2a31` (hover/strong border)
- `--text: #f5f5f7` (primary text)
- `--text-muted: #a1a1aa` (secondary)
- `--text-subtle: #71717a` (tertiary — derived, matches zinc-500)

**Accent — burnt orange (the InariWatch brand color):**
- `--accent: #ea580c` (Tailwind orange-600 — primary accent, buttons/links/focus rings)
- `--accent-hover: #c2410c` (orange-700 — hover state)
- `--accent-light: #fb923c` (orange-400 — for highlights, gradient starts)
- `--accent-gradient: linear-gradient(135deg, #fb923c 0%, #ea580c 55%, #c2410c 100%)` (matches `web/app/globals.css` line 106)
- Use the burnt-orange gradient for hero CTAs / large accent surfaces. Use solid `#ea580c` for everything else (buttons, status pills, focus rings, links).

**Status semantic colors** (these stay regardless of brand — they're status, not brand):
- `--success: #4cb782` (green — On track / passed gate)
- `--warning: #f0a020` (amber — At risk / pending)
- `--danger: #eb5757` (red — Off track / failed)
- Category pills get muted versions of brand orange / status colors

**Anti-pattern:** do NOT use Linear's purple `#5e6ad2` even though it's all over the screenshots. That's Linear's brand. Inari Live's brand is burnt orange `#ea580c`. Every place a Linear screenshot shows their purple (selected sidebar item, accent button, status indicator) — replace with `#ea580c`.

### Status semantic colors (with colored 6-8px dot prefix)
- `● On track` / success: green (#4cb782 or similar, low saturation)
- `● At risk` / warning: amber-yellow (#f0a020)
- `● Off track` / danger: red (#eb5757)
- Category pills: each label has its own muted color (Reliability=purple, Bug=red, Performance=green, iOS=blue, Maps=yellow…)

### Typography
- Inter (or Inter Tight at 13px and below)
- Font weights: 400 body, 500 emphasized, 600 headers
- Sizes: 11 / 12 / 13 / 15 / 18 / 24 / 32 (no in-between)
- Line height generous for body (1.5), tight for UI (1.3)

### Spacing scale
- 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 (no random values)

### Border radius
- sm: 6px (buttons, pills)
- md: 8px (action squares, small cards)
- lg: 12px (large cards, modals)

### Microinteractions
- Hover: bg opacity change ONLY (no scale, no shadow, no rotate)
- Click: bg darkens slightly more
- Transitions: 150ms cubic-bezier(0.16, 1, 0.3, 1) on bg / opacity / transform
- Page enter: fadeIn 200ms

### Anti-patterns (do NOT do)
- ❌ Drop shadows heavy
- ❌ Gradients (except subtle on accent)
- ❌ Border-radius round (pills > 12px max except avatars circular)
- ❌ Hover scale (1.05) — looks consumer-y
- ❌ Loading spinners — use skeleton loaders instead
- ❌ Brightly saturated colors (Linear is desaturated, gray-leaning)
- ❌ More than 1-2 accent colors per screen
- ❌ Modal backdrops black 50% — too heavy. Use 30-40% with blur

## How the executor should reference these

When making design decisions during S33, refer back to:
- "matches `01-inbox-detail-view.png` sidebar"
- "uses status pill style from `02-my-issues-list.png`"
- "page header pattern from `06-issue-detail-right-panel.png`"

If a pattern is not visible in any of the 9 screenshots, ask Jesús for guidance OR fall back to "what would Linear do" (matches the design language).
