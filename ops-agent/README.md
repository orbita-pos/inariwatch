# ops-agent

Tiny HTTP API that exposes host + docker + systemd state to the InariWatch `/admin/ops` dashboard. Runs on each Hetzner box on `127.0.0.1:9500`, authenticated via `Bearer $OPS_AGENT_SECRET`.

## Endpoints

| Route | Returns |
|---|---|
| `GET /host` | hostname, kernel, OS, arch, uptime, load avg, memory, root disk |
| `GET /docker` | `docker ps -a --format json` parsed into a list |
| `GET /systemd` | running services (unit, load, active, sub, description) |
| `GET /logs/:name?lines=N` | last N lines of `journalctl -u <name>.service`; service must be in the allow-list in `main.go` |
| `GET /healthz` | `ok` — no auth, for systemd/proxy probes |

## Build

```bash
# native
go build -o ops-agent .

# linux/amd64 (from Windows or macOS)
GOOS=linux GOARCH=amd64 go build -o ops-agent .
```

Binary is static (stdlib only), ~6 MB.

## Deploy

`scp ops-agent root@box:/usr/local/bin/ && scp systemd/ops-agent.service root@box:/etc/systemd/system/`

Secret lives at `/etc/ops-agent/env` as `OPS_AGENT_SECRET=...` — same value as `OPS_AGENT_SECRET` in `web/.env.sops.yaml` so the web admin UI can authenticate.

```bash
ssh box 'systemctl daemon-reload && systemctl enable --now ops-agent'
```
