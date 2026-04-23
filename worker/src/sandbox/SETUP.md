# Fase 5 — CodeAct sandbox host setup (Hetzner)

This is a one-time provisioning runbook for the Hetzner worker host. The
worker runs as `inari-worker` (systemd, native Node.js) per `CLAUDE.md`
— it spawns the Deno + Pyodide subprocess directly on the host. Both
have to be present before `CODEACT_ENABLED=true`.

## What we install

| Component | Version | Path | Why |
|---|---|---|---|
| Deno | pin to a 2.x point release at install time (record below) | `/usr/local/bin/deno` | Outermost layer of the sandbox — default-deny semantics (no `--allow-*` flags beyond a narrow `--allow-read` on `/opt/sandbox`) block file write, network, env access, and exec |
| Pyodide cache | 0.28 (pinned) | `/opt/sandbox/.deno-cache/npm/registry.npmjs.org/pyodide/...` | No `npm install` at runtime — pre-baked per GPT54 §B9 |
| `pyodide-runner.ts` | from this commit | `/opt/sandbox/pyodide-runner.ts` | Deno script — `runner.ts` spawns it |

The worker's `runner.ts` reads three env vars to locate them, all with
the defaults shown above:

- `SANDBOX_DENO_BINARY` (default `/usr/local/bin/deno`)
- `SANDBOX_RUNNER_PATH` (default `/opt/sandbox/pyodide-runner.ts`)
- `SANDBOX_READ_ROOT` (default `/opt/sandbox`) — the only directory Deno
  is permitted to read

## Provisioning steps

```bash
# 1. Install Deno 2.x (record the exact version chosen below)
curl -fsSL https://deno.land/install.sh | sh -s -- --yes
sudo mv ~/.deno/bin/deno /usr/local/bin/deno
sudo chmod 755 /usr/local/bin/deno
deno --version  # record this exact line in the install log

# 2. Pre-bake the Pyodide cache (no net needed at remediation time)
sudo mkdir -p /opt/sandbox/.deno-cache
sudo chown root:root /opt/sandbox
sudo chmod 755 /opt/sandbox
sudo DENO_DIR=/opt/sandbox/.deno-cache deno cache npm:pyodide@0.28

# 3. Install the runner script (copy from this repo)
sudo cp worker/src/sandbox/pyodide-runner.ts /opt/sandbox/pyodide-runner.ts
sudo chmod 644 /opt/sandbox/pyodide-runner.ts

# 4. Verify the runner can boot offline (no net, no privileges)
sudo -u inari-worker -- env DENO_DIR=/opt/sandbox/.deno-cache \
    deno run --allow-read=/opt/sandbox \
             --no-prompt --node-modules-dir=auto \
             --v8-flags=--max-old-space-size=256 \
             /opt/sandbox/pyodide-runner.ts <<< ''
# Expected first line on stdout: {"type":"ready"}
# Then the process waits for an `init` message on stdin — Ctrl+C to exit.
```

## Worker env additions

Add to `/opt/inari-worker/.env` on the Hetzner host:

```ini
# Fase 5 — CodeAct sandbox. Default false; flip to true only after the
# adversarial test suite is green and the IRP §3.3 kill switch has been
# tested. See REMEDIATION_SYSTEM_ARCHITECTURE.md §4 Fase 5.
CODEACT_ENABLED=false

# Point Deno at the pre-baked cache so the subprocess never hits npm at
# remediation time. MUST match step 2 of the provisioning above. The
# worker spawn copies this into the subprocess env as DENO_DIR.
SANDBOX_DENO_DIR=/opt/sandbox/.deno-cache

# Optional overrides (defaults shown):
# SANDBOX_DENO_BINARY=/usr/local/bin/deno
# SANDBOX_RUNNER_PATH=/opt/sandbox/pyodide-runner.ts
# SANDBOX_READ_ROOT=/opt/sandbox
```

After editing `.env`, restart the worker:

```bash
sudo systemctl restart inari-worker
```

## IRP §3.3 kill switch — verified procedure

If a CodeAct sandbox escape is suspected (per
`SECURITY_AND_COMPLIANCE_ROADMAP.md` §3.3 Phase 2):

```bash
# 1. Disable across all workers (single Hetzner host today, but the
#    instruction generalizes once we run multiple workers).
sudo sed -i 's/^CODEACT_ENABLED=true/CODEACT_ENABLED=false/' \
    /opt/inari-worker/.env

# 2. Restart the worker — flag is read fresh per spawn, no in-flight
#    sandbox can survive a restart.
sudo systemctl restart inari-worker

# 3. Verify: tail the worker journal and confirm no further
#    "sandbox spawn" log lines appear after the restart.
sudo journalctl -u inari-worker -f | grep -i sandbox
```

The agent loop falls through to its standard tool-use path with no
behavior change for callers — `execute_plan` simply isn't in the tool
list when the flag is off.

## Monthly CVE review

Per `SECURITY_AND_COMPLIANCE_ROADMAP.md` line 368: review Deno + Pyodide
CVE feeds monthly and bump pinned versions if any advisory affects the
sandbox surface. Steps:

1. Check https://deno.com/blog (security advisories tag)
2. Check https://github.com/pyodide/pyodide/security/advisories
3. If a relevant CVE exists: bump pinned versions in this file, redo
   step 2 of provisioning, redeploy, re-run the adversarial test suite
   in CI.

Record review date + outcome in `runbook/sandbox-cve-log.md` (create on
first review).

## Why no `worker/Dockerfile`

The worker is native systemd on Hetzner per `CLAUDE.md`. The Dockerfile
snippet in arch doc §4 Fase 5 (lines 405-414) and GPT54 §B9 was
assuming a containerized worker — that's not the topology we ship.
Equivalent isolation comes from the existing per-remediation gVisor
container (PR #8) plus Deno's default-deny permission model (only a
narrow `--allow-read=/opt/sandbox` is granted).

The triple-layer defense from arch doc §Pillar 3 stays intact:

1. **Pyodide WASM** — no `os.system`, no `subprocess`, no socket
2. **Deno default-deny + `--allow-read=/opt/sandbox`** — denies file write,
   network, env access, exec
3. **Existing gVisor container (PR #8)** — every `read_file` /
   `apply_patch` / `run_command` from inside the sandbox crosses back
   over RPC to the worker, which forwards to the Go staging server,
   which executes inside the gVisor container. The sandbox never
   touches the worker's filesystem or the Hetzner host network directly.
