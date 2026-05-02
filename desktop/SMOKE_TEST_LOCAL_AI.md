# Inari Live -- Local AI smoke test (S31, dev box)

This document is the runbook for validating the local-AI stack (Tab autocomplete via Qwen-1.5B + Fast Apply via Kortix-7B) end-to-end on the S31 dev box. It assumes Sesión 31 (`feat/inari-live-v0.2-session31-local-models`) has been executed -- if you are starting fresh on a new machine, run **Setup** first.

S31 explicitly does NOT cover: code signing, R2 distribution, public download landing, CI release matrix. Those are deferred until ~50 active beta users (`feedback_no_signing_pre_users.md`).

---

## Setup (one-time per dev box)

### 1. llama-server sidecar binary

The runtime resolves the binary in this order (`src-tauri/src/local_ai/runtime.rs::resolve_sidecar_binary`):

1. `<resource_dir>/llama-server-windows-x86_64.exe` (preferred -- not yet bundled, lands in S32)
2. `<resource_dir>/llama-server.exe`
3. `<app_local_data>/inari-live/bin/llama-server.exe` **(this is what S31 uses on Windows)**
4. `which llama-server` (PATH fallback)

Until S32 wires `tauri.conf.json::bundle.resources`, install via path #3:

```powershell
# Download latest llama.cpp Windows-Vulkan release
$tag = (gh release view --repo ggml-org/llama.cpp --json tagName --jq .tagName)
$asset = "llama-$tag-bin-win-vulkan-x64.zip"
$url = "https://github.com/ggml-org/llama.cpp/releases/download/$tag/$asset"
$tmp = "$env:TEMP\$asset"
curl.exe -L --ssl-revoke-best-effort --fail -o $tmp $url
Expand-Archive -Path $tmp -DestinationPath "$env:TEMP\llama-extract" -Force

# Copy binary + all DLLs to the sideload bin directory
$bin = "$env:LOCALAPPDATA\com.inariwatch.desktop\inari-live\bin"
New-Item -ItemType Directory -Path $bin -Force | Out-Null
Copy-Item "$env:TEMP\llama-extract\*" -Destination $bin -Force

# Verify
& "$bin\llama-server.exe" --version
```

Expected: `version: 9002 (...)` and `load_backend: loaded Vulkan backend ...`.

### 2. GGUF models

Use the helper script at `desktop/scripts/sideload-models.ps1`.

```powershell
# Install b3sum once
cargo install b3sum

# Download GGUFs to a staging dir
$stage = "D:\inari-models-staging"
New-Item -ItemType Directory -Path $stage -Force | Out-Null
curl.exe -L --ssl-revoke-best-effort --fail `
  -o "$stage\Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf" `
  "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf"
curl.exe -L --ssl-revoke-best-effort --fail `
  -o "$stage\FastApply-7B-Q4_K_M.gguf" `
  "https://huggingface.co/Kortix/FastApply-7B-v1.0_GGUF/resolve/main/hf.Q4_K_M.gguf"

# Verify + install
.\desktop\scripts\sideload-models.ps1 -Gguf "$stage\Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf" -ModelId qwen2.5-coder-1.5b
.\desktop\scripts\sideload-models.ps1 -Gguf "$stage\FastApply-7B-Q4_K_M.gguf"          -ModelId kortix-fast-apply-7b
.\desktop\scripts\sideload-models.ps1 -List
```

Expected: both rows show `[installed] ... size=ok`.

### 3. Local AI tier persistence

The Apply path (`ai/remediate/single_shot.rs::try_fast_apply_local`) reads `settings.local_ai_tier` instead of live-detecting hardware (Sesión 25 decision). The dev box has 16+ GB RAM and 8+ logical cores -> Tier2.

The setting is auto-populated on first daemon boot via `local_ai::hardware::detect()` -> `record_detected_tier`. To force it manually (e.g. test the local Apply path on a Tier1 box):

```powershell
# After at least one `npm run tauri dev` run has created the store
$db = "$env:LOCALAPPDATA\com.inariwatch.desktop\inari-live\store.db"
sqlite3 $db "INSERT INTO settings(key,value,updated_at) VALUES('local_ai_tier','tier2',unixepoch()*1000) ON CONFLICT(key) DO UPDATE SET value='tier2';"
```

---

## Run

```powershell
cd desktop
npm install                # first time only
npm run tauri dev
```

Expected on stdout:

- `[lsp] listening on 127.0.0.1:9877 (LocalAI wired)` -- if you see `(no LocalAI -- empty completions)` instead, the sidecar binary or models are missing; re-run Setup.
- The Inari Live main window opens (1280x820, frameless).

---

## VS Code LSP client setup

VS Code does not have a built-in TCP LSP client; install **Generic LSP Client** by Tamas Galffy (`tamasfe.even-better-toml` is unrelated -- pick the one with the gear icon labeled "Generic LSP Client").

Add to `.vscode/settings.json` of the workspace you're editing:

```json
{
  "genericLspClient.enable": true,
  "genericLspClient.servers": [
    {
      "name": "inari-lsp",
      "transport": { "kind": "tcp", "port": 9877, "host": "127.0.0.1" },
      "filetypes": ["typescript", "javascript", "python", "rust"]
    }
  ]
}
```

Reload the VS Code window. The LSP status bar should show `inari-lsp: ready`.

**Neovim alternative:** `lspconfig` with the bundled `inari-lsp-stdio` sidecar (Sesión 22):

```lua
local inari_lsp_stdio = vim.fn.expand("~/.cargo/target-shared/debug/inari-lsp-stdio.exe")
-- or the bundled path once S32 ships: <app_resource_dir>/inari-lsp-stdio.exe
require("lspconfig.configs").inari_lsp = {
  default_config = {
    cmd = { inari_lsp_stdio },
    filetypes = { "typescript", "javascript", "python", "rust" },
    root_dir = require("lspconfig").util.find_git_ancestor,
  },
}
require("lspconfig").inari_lsp.setup({})
```

---

## Test cases

### TC-1 -- Tab autocomplete (Qwen-1.5B FIM)

1. Open any TypeScript file with at least 50 lines (`web/lib/services/alerts.service.ts` is good).
2. Place cursor mid-function, after a `function `, `const `, or `// TODO ` line.
3. Wait 200-300ms. Ghost-text should appear suggesting completion.

**Pass criteria:**
- p50 latency under 300 ms (relaxed from spec's 120 ms because dev mode has webview overhead).
- Ghost text is syntactically plausible code (not chat-style "Sure, here's...").
- Cancel-on-keystroke: typing aborts the in-flight stream within ~50 ms (no stale ghost text).

**If Tab does not appear:**
- Check `lsp` log line above. `(no LocalAI -- empty completions)` means models missing.
- VS Code: `Output -> Generic LSP Client` shows the request/response stream.
- `tail -f $env:LOCALAPPDATA\com.inariwatch.desktop\inari-live\logs\inari-live.*.log` (Sesión 17 path).

### TC-2 -- Fast Apply (Kortix-7B chat-style)

1. Open the Inari Live dock (`Ctrl+Space`).
2. Open the chat panel.
3. Pick a small TypeScript file in the open repo (under 200 lines).
4. Type something like: `add a null check before line 12`.
5. Click apply.

**Pass criteria:**
- Diff renders within 1-3 seconds of submit (Kortix-7B is bigger than Qwen, so first-call has model-load cost; subsequent calls reuse the warm sidecar).
- Diff is unified-diff format (`@@ -L,N +L,N @@` headers).
- `RemediationDraft` shows `model_used: "kortix-7b-local"` and `cents: 0` in the dock telemetry row (Sesión 25 contract).

**If Apply falls through to cloud:**
- Local apply is gated on `settings.local_ai_tier in ("tier1","tier2")` AND `local_apply_enabled = true`. Check Settings -> AI panel.
- Sesión 25 decision: every local failure transparently falls back to the cloud path -- an empty diff or a slow response are NOT signals that the local path failed; check `aiReasoning` for `kortix-7b-local` vs `gpt-5.4`.

### TC-3 -- Pre-push gate (Gates 5/6 use local Qwen)

1. In an active repo with the Inari Live daemon running, stage and `git push` a deliberately-broken commit (e.g. an unhandled null reference).
2. Pre-push hook runs the gate pipeline (Sesión 16 + Q3 in cloud parity).

**Pass criteria:**
- Gates 5 (`substrate_simulate`) and 6 (`eap_chain_verified`) run locally; the pre-push log shows `gate-5: pass (local-llama)` and `gate-6: pass (eap-local)` (Sesión 24 EAP local verify).
- Push is blocked with a clear error if the broken code trips a gate.

### TC-4 -- EAP receipt chip + Replay button (Sesión 27 + 28)

1. Run a full remediation that produces a `.eap.json` receipt (the `eap_receipts` mirror table populates per Sesión 27 pending follow-up; for now seed manually):

```powershell
$db = "$env:LOCALAPPDATA\com.inariwatch.desktop\inari-live\store.db"
sqlite3 $db "INSERT INTO eap_receipts(receipt_id,merkle_root,signature,public_key,key_id,attestor,created_at_ms) VALUES('test-receipt-1','aa'*32,'bb'*64,'cc'*32,'66687aadf862bd77','test-attestor',unixepoch()*1000);"
```

2. Open the dock -> any active fix -> `<section data-testid="dock-diff-attestation">` should render the chip + Replay button.
3. Click the chip -> modal shows prompt + sig.
4. Click Replay -> should POST to `/v2/replay` on Hetzner.

**Pass criteria:**
- Chip renders with `Signed` badge.
- Replay returns a verdict (green tick if reproduced, red if not). If the Hetzner `/v2/replay` endpoint is down, the modal shows `RequestFailed` (Sesión 27 tagged-union -- not a hard error).
- Export button writes `.eap.json` via the native save dialog (Sesión 28). Verify with `cargo run -p inariwatch-desktop --bin inari-verify -- ./test-receipt-1.eap.json`.

---

## Known issues / out of scope for S31

| Issue | Why | Resolution |
|---|---|---|
| 0.5B fallback model still placeholder | Dev box is Tier2; 0.5B tested in a future <8 GB RAM session | Future PR replaces with real digest |
| `tauri.conf.json` does NOT bundle `resources/llama-server-windows/*` | S32 owns release pipeline + signing + bundle | Sideload via Setup #1 above |
| No CI workflow downloads + caches the GGUFs | S32 owns the release CI matrix | n/a -- developers run Setup once per box |
| First Tab call has cold-start cost (~1-2 s) | llama-server spawns + loads Q4_K_M GGUF on first generate() | Subsequent calls reuse the warm sidecar; the dock could pre-warm at startup, deferred to a future UX session |
| Schannel revocation check fails on `curl.exe` | Windows-Schannel cannot reach CRL/OCSP | Always pass `--ssl-revoke-best-effort` to `curl.exe` on this box |

---

## Reverting

To wipe local AI state without touching the rest of the daemon:

```powershell
$root = "$env:LOCALAPPDATA\com.inariwatch.desktop\inari-live"
Remove-Item -Recurse -Force "$root\models"
Remove-Item -Recurse -Force "$root\bin"
sqlite3 "$root\store.db" "DELETE FROM local_models; UPDATE settings SET value='' WHERE key IN ('local_ai_tier','local_ai_enabled','local_ai_default_model');"
```

Restart the daemon. The LSP listener will log `(no LocalAI -- empty completions)`, the dock's AI section will show "no local models installed", and Tab/Apply silently degrade to cloud (or empty for Tab).
