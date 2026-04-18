# Q3 Phase 2 — EAP server deploy on Hetzner

End-to-end steps to bring `eap.inariwatch.com` online. All code is already
merged to `main` on both repos:
- `orbita-pos/eap` commit `32e8e54` (Rust server + `POST /receipts/from-events`)
- `orbita-pos/inariwatch` commit `9ab8b20` (submission pipeline + alert link)

After this deploy, every successful remediation with a substrate recording
automatically generates a signed EAP receipt and surfaces the public audit
link `/attestation/<id>` on the alert detail page.

Estimated time: 20–30 min (first build is slow; subsequent rebuilds are fast).

---

## 0 · Pre-flight (local laptop, 5 min)

Generate a GitHub Deploy Key for the EAP repo — Hetzner needs read-only
clone access. Mirrors the existing `~/.ssh/inariwatch_deploy` pattern
documented in `project_hetzner_deploy.md`.

```bash
# On your laptop:
ssh-keygen -t ed25519 -f ~/.ssh/eap_deploy -N "" -C "hetzner-eap-deploy"

# Print the public key so you can paste it into GitHub:
cat ~/.ssh/eap_deploy.pub
```

Then go to `https://github.com/orbita-pos/eap/settings/keys/new` and paste
the public key. Title: "inari-staging (read-only)". Do **not** check
"Allow write access".

Copy the private key to Hetzner:

```bash
scp ~/.ssh/eap_deploy inari-staging:~/.ssh/eap_deploy
ssh inari-staging 'chmod 600 ~/.ssh/eap_deploy'
```

---

## 1 · Clone + build EAP on Hetzner (~10 min first time)

```bash
ssh inari-staging
```

From the Hetzner shell:

```bash
# Add an SSH config alias for GitHub scoped to this repo.
cat >> ~/.ssh/config <<'EOF'

Host github-eap
  HostName github.com
  User git
  IdentityFile ~/.ssh/eap_deploy
  IdentitiesOnly yes
EOF

# Clone.
sudo mkdir -p /opt/eap
sudo chown -R $USER:$USER /opt/eap
git clone git@github-eap:orbita-pos/eap.git /opt/eap
cd /opt/eap

# Build — uses the same Rust toolchain installed for the InariWatch Agent
# per project_ebpf_agent.md ("Rust 1.94.1"). Release profile = ~2-5 min.
cargo build --release -p eap-server -p eap-cli

# Verify the binaries built.
ls -l target/release/eap-server target/release/eap
```

Both binaries should exist. If `cargo build` fails with "linker not found",
install `clang` (already done per agent setup — sanity check with
`clang --version`).

---

## 2 · Generate the attestor keypair (Ed25519) + API key

The server signs every receipt with the attestor key. The key file must
exist before starting the service — otherwise receipts are returned
unsigned (still a valid Merkle root, but no signature).

```bash
# On Hetzner, still in /opt/eap:
./target/release/eap keygen

# This writes ~/.eap/key and prints the public key. Save the public key —
# customers will need it to verify receipts independently.
cat ~/.eap/pub

# Lock down the private key.
chmod 600 ~/.eap/key
```

Generate a random API key for write-auth:

```bash
EAP_API_KEY=$(openssl rand -hex 32)
echo "$EAP_API_KEY"  # copy this — you'll paste it into Vercel too
```

---

## 3 · Systemd unit

```bash
sudo tee /etc/systemd/system/eap-server.service > /dev/null <<EOF
[Unit]
Description=EAP Attestation Server
After=network.target
Wants=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/eap
Environment="EAP_API_KEY=$EAP_API_KEY"
Environment="EAP_ATTESTOR_KEY_PATH=$HOME/.eap/key"
Environment="EAP_CORS_ORIGINS=https://app.inariwatch.com,https://inariwatch.com"
Environment="RUST_LOG=info"
ExecStart=/opt/eap/target/release/eap-server --db $HOME/.eap/receipts.db --bind 127.0.0.1:9402
Restart=on-failure
RestartSec=5s

# Harden — don't allow the service to touch anything it shouldn't.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$HOME/.eap

[Install]
WantedBy=multi-user.target
EOF

# Check eap-server CLI args match the serve() signature in server/src/lib.rs
# (we expect --db <path> --bind <addr>). If the binary doesn't accept those
# flags, look at what the main.rs actually exposes and adjust ExecStart.
/opt/eap/target/release/eap-server --help 2>&1 | head -10

sudo systemctl daemon-reload
sudo systemctl enable eap-server
sudo systemctl start eap-server

# Verify it's up.
sudo journalctl -u eap-server -n 30 --no-pager
```

Expected log lines:
```
attestor keypair loaded from /root/.eap/key
API key authentication enabled for POST routes
EAP server listening on 127.0.0.1:9402
SQLite: /root/.eap/receipts.db
```

Smoke test directly (still on Hetzner):

```bash
curl -s http://127.0.0.1:9402/health | jq .
# → { "status": "ok", "version": "0.1.0" }
```

---

## 4 · Caddy route — expose publicly as `eap.inariwatch.com`

```bash
# Edit whatever Caddyfile your Hetzner uses. If it's /etc/caddy/Caddyfile:
sudo tee -a /etc/caddy/Caddyfile > /dev/null <<'EOF'

eap.inariwatch.com {
    reverse_proxy 127.0.0.1:9402
    encode gzip
    # Let the EAP server set its own CORS + cache headers.
    # Rate limit at the edge — one instance is enough for Q3 Phase 2.
    header Strict-Transport-Security "max-age=63072000"
}
EOF

sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Then add the DNS record (Cloudflare / whatever you use):
- `eap.inariwatch.com` → A record → your Hetzner IP

Wait ~60 seconds for DNS + Let's Encrypt cert provisioning, then:

```bash
# From your laptop:
curl -s https://eap.inariwatch.com/health | jq .
# → { "status": "ok", "version": "0.1.0" }
```

If Caddy fails to get a cert, check `sudo journalctl -u caddy -n 50` and
confirm port 80 + 443 are reachable externally (ufw / cloud firewall).

---

## 5 · Point InariWatch at the live EAP server

Set the two env vars on Vercel (Production + Preview if you want Preview
attestations too):

```bash
# From your laptop:
npx vercel env add EAP_SERVER_URL production
# paste: https://eap.inariwatch.com

npx vercel env add EAP_API_KEY production
# paste: the hex string from step 2

# Redeploy so the env takes effect on the running app.
npx vercel --prod
```

---

## 6 · End-to-end smoke test

Once Vercel's redeploy is live (check in the Vercel dashboard or wait for
`vercel --prod` to print "Deployment complete"):

```bash
# From your laptop, hit the public attestation endpoint with a known-bad
# receipt id to prove the proxy reaches the EAP server:
curl -s https://app.inariwatch.com/api/attestation/0000000000000000 | jq .
# → { "error": "receipt not found" }   ← EAP server responded 404, proxy
#                                        passed it through correctly.
```

If you see `{ "error": "EAP attestation server not yet configured ..." }`
instead, the Vercel env vars didn't propagate — redeploy once more.

Create a real receipt via a live remediation to complete the round-trip:
1. Trigger a remediation on a test alert that has a substrate recording
2. Watch the remediation complete; when it merges the SSE stream emits
   `eap_receipt { receiptId, signed }`
3. Reload the alert detail page — the "EAP attestation available" card
   appears between CommunityFixBanner and RemediationPanel
4. Click "view audit →" — lands on `/attestation/<id>` rendering the
   chain + verification badge

---

## 7 · Operational notes

**Backups.** The receipt DB at `~/.eap/receipts.db` is the source of
truth for every signed attestation. Back it up alongside Neon:

```bash
# Quick cron-based backup (add to /etc/cron.daily/eap-backup):
#!/bin/bash
BACKUP_DIR=/var/backups/eap
mkdir -p "$BACKUP_DIR"
sqlite3 /root/.eap/receipts.db ".backup '$BACKUP_DIR/receipts-$(date +%F).db'"
# Retain 30 days:
find "$BACKUP_DIR" -name 'receipts-*.db' -mtime +30 -delete
```

**Attestor key rotation.** The Ed25519 private key at `~/.eap/key` signs
every receipt. Rotating it invalidates future verifications against the
old public key. Only rotate if compromise is suspected. When you do:
1. `./target/release/eap keygen --out ~/.eap/key.new`
2. Publish the new public key alongside the old one in the trust page
3. `mv ~/.eap/key.new ~/.eap/key && systemctl restart eap-server`

**CORS.** `EAP_CORS_ORIGINS` limits who can call the server directly
from a browser. For third-party verification tools (per the "verifiable
forever" pitch), they'll call `app.inariwatch.com/api/attestation/:id`
(which allows `*` for GET) rather than the EAP server directly, so the
restrictive origin list is the right default.

**Upgrades.** `cd /opt/eap && git pull && cargo build --release -p eap-server && sudo systemctl restart eap-server`.

---

## Rollback

If something goes catastrophically wrong post-deploy:

```bash
# Immediate: stop EAP server. InariWatch will gracefully degrade —
# Phase 1's /api/attestation/:id returns 503 + hint, the alert card
# just doesn't render.
sudo systemctl stop eap-server

# Or unset the env on Vercel to force the graceful-degradation path
# without touching Hetzner:
npx vercel env rm EAP_SERVER_URL production
npx vercel --prod
```

Receipts generated before rollback stay valid forever (content-addressed
+ signed). Removing the server only stops NEW receipts from being created.
