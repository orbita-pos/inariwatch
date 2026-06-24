# Inari Live — shell hooks (Sensor 2)

This directory holds the per-shell hook templates the Inari Live
desktop app installs into your interactive shell when you toggle
**Watch my terminal** in the dock. Sourced from your shell's rc file
(`~/.zshrc` / `~/.bashrc` / `~/.config/fish/config.fish`) via a single
`source` line, the hooks forward `{cmd, cwd, exit_code, duration_ms,
timestamp}` to the daemon over a per-platform local socket
(`~/.inari/sock/shell.sock` on Unix, `\\.\pipe\inari-live-shell` on
Windows).

The feature is **opt-in** and **default OFF**. Toggling it off via the
dock removes the `source` line and the `~/.inari/shell/` payload (the
Rust uninstaller is idempotent — running it without an installation
is a no-op).

---

## Threat model & privacy

Hooks send metadata about every command you run while they're sourced.
The daemon writes each event to a row in the local SQLite store
(`events` table, `kind = 'shell_event'`) and broadcasts it on the
in-process bus for downstream consumers (memory layer, dock UI,
analytics). Nothing leaves your machine.

**Privacy-scrubbing happens IN THE SCRIPT, before the payload leaves
your shell.** The daemon does not have a chance to see the raw value;
if scrubbing fails, the daemon receives the unscrubbed text. The Rust
port at `desktop/src-tauri/src/sensors/shell/installer.rs::scrub_secrets`
is the canonical regex; the shipped scripts implement an equivalent
sed pipeline.

### Audit list — what the scrubber redacts

The scrubber matches assignments of the form `IDENT=value` where the
identifier contains one of these UPPERCASE substrings:

| Token      | Example match                                |
| ---------- | -------------------------------------------- |
| `KEY`      | `OPENAI_API_KEY=…`, `KEY=…`, `MY_KEY_X=…`    |
| `SECRET`   | `AWS_SECRET_ACCESS_KEY=…`, `MY_SECRET=…`     |
| `TOKEN`    | `GITHUB_TOKEN=…`, `BEARER_TOKEN=…`           |
| `PASSWORD` | `DB_PASSWORD=…`                              |
| `PASSWD`   | `MYSQL_PASSWD=…`                             |
| `PWD`      | `ROOT_PWD=…` (collides with `$PWD` — rare)   |

The exact regex (sed `-E`):

```sed
([A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)[A-Za-z0-9_]*)=[^[:space:]]+
```

The matched value is replaced with `***`, so:

```
OPENAI_API_KEY=sk-abc123 npm run dev
```

reaches the daemon as:

```
OPENAI_API_KEY=*** npm run dev
```

### Known limitations

* **Lower-case identifiers slip through.** `my_token=foo` is NOT
  scrubbed. Convention is upper-snake-case for env vars; if you've
  custom-named secrets in lower case, audit the sender accordingly.
* **Quoted multi-word values are partially scrubbed.** A value like
  `KEY="my secret"` is rewritten to `KEY=*** secret"` — the trailing
  token escapes the regex (`[^[:space:]]+` stops at the first space).
  Practical impact is low (most env vars are unquoted single tokens),
  but the v0.1 fix is to use `printf %q` style escaping or wait for
  v0.2 of the scrubber.
* **Inline secrets that don't look like assignments are NOT touched.**
  `curl -H 'Authorization: Bearer sk-abc'` reaches the daemon
  verbatim. The scrubber is intentionally conservative: false-positive
  redactions on legitimate command text would make telemetry less
  useful than it is dangerous.

If a value pattern matters to you that the regex misses, edit
`~/.inari/shell/inari.<shell>` and add a corresponding sed line to
`__inari_scrub`. Your edits are clobbered by the next install — see
the dock's **Watch my terminal** toggle for re-sourcing the bundled
script.

---

## bash setup (one extra step)

zsh and fish ship `preexec` / `precmd` hooks natively. Bash does not.
The bash template hooks into [`bash-preexec`](https://github.com/rcaloras/bash-preexec)
which you must install yourself BEFORE the Inari Live `source` line:

```bash
# ~/.bashrc — install bash-preexec once
[[ -f ~/.bash-preexec.sh ]] || \
    curl -sL https://raw.githubusercontent.com/rcaloras/bash-preexec/master/bash-preexec.sh \
    > ~/.bash-preexec.sh
source ~/.bash-preexec.sh

# Inari Live appends its own source line here — keep this AFTER bash-preexec.
```

The Inari Live installer does NOT bundle `bash-preexec` — it's an
independent project with its own update cadence. The bash template
silently no-ops if `preexec_functions` / `precmd_functions` arrays
aren't defined, so a stale install never breaks an interactive shell.

---

## Rate limiting

Each connection is rate-limited at 10 events/sec (sliding window) on
the daemon side. Excess events are dropped with a `tracing::warn!`
line; the connection stays open. The cap is intentional: a runaway
`for i in {1..1000}; do echo $i; done` loop should not flood the bus
or fill the SQLite events table.

---

## Uninstall

Toggling off **Watch my terminal** in the dock calls
`installer::uninstall(shell)` and removes:

* the `source` line from `~/.zshrc` / `~/.bashrc` /
  `~/.config/fish/config.fish` (matched by the trailing
  `# inari-live shell hook (Sensor 2)` marker),
* the per-shell payload at `~/.inari/shell/inari.<shell>`.

The directory `~/.inari/shell/` is left in place if other shells are
still installed; the dock's full reset is a future session.
