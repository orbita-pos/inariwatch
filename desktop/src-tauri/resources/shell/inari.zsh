# Inari Live — zsh shell hook (Sensor 2, Session 9)
# Sourced from ~/.zshrc when "Watch my terminal" is enabled.
# Forwards each command's metadata to the local daemon over a Unix
# domain socket. Privacy-scrubbing happens HERE, before any data
# leaves the shell. See ~/.inari/shell/README.md for the threat model
# and the audit list.

__INARI_SOCK="${HOME}/.inari/sock/shell.sock"

# Scrub env-var-shaped secrets:
# IDENT=value where IDENT contains KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD
# as an uppercase substring becomes IDENT=***.
__inari_scrub() {
    sed -E 's/([A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)[A-Za-z0-9_]*)=[^[:space:]]+/\1=***/g'
}

# Send {cmd, cwd, exit_code, duration_ms, timestamp} as a JSON line on
# the daemon's Unix socket, in the background, with a hard 300ms
# timeout so a stopped daemon never blocks the user's prompt.
__inari_send() {
    local cmd="$1" exit_code="$2" duration_ms="$3"
    local cwd="$PWD"
    local timestamp
    timestamp=$(date +%s%3N 2>/dev/null || echo 0)
    cmd=$(printf '%s' "$cmd" | __inari_scrub)
    if command -v python3 >/dev/null 2>&1; then
        (
            python3 - "$__INARI_SOCK" "$cmd" "$cwd" "$exit_code" "$duration_ms" "$timestamp" <<'__INARI_PY' &
import socket, json, sys
sock_path, cmd, cwd, exit_code, duration_ms, timestamp = sys.argv[1:]
payload = json.dumps({
    "cmd":         cmd,
    "cwd":         cwd,
    "exit_code":   int(exit_code),
    "duration_ms": int(duration_ms),
    "timestamp":   int(timestamp),
})
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(0.3)
    s.connect(sock_path)
    s.sendall((payload + "\n").encode())
    s.close()
except Exception:
    pass
__INARI_PY
        ) >/dev/null 2>&1
    fi
}

__inari_pre_cmd=""
__inari_pre_t0=0

__inari_preexec_hook() {
    __inari_pre_cmd="$1"
    __inari_pre_t0=$(date +%s%3N 2>/dev/null || echo 0)
}

__inari_precmd_hook() {
    local exit_code=$?
    if [[ -n "$__inari_pre_cmd" ]]; then
        local now elapsed
        now=$(date +%s%3N 2>/dev/null || echo 0)
        elapsed=$(( now - __inari_pre_t0 ))
        (( elapsed < 0 )) && elapsed=0
        __inari_send "$__inari_pre_cmd" "$exit_code" "$elapsed"
        __inari_pre_cmd=""
    fi
}

# Register on zsh's built-in hook arrays. Idempotent — sourcing the
# file twice does not duplicate registrations.
typeset -ga preexec_functions precmd_functions
if [[ ${preexec_functions[(I)__inari_preexec_hook]} -eq 0 ]]; then
    preexec_functions+=(__inari_preexec_hook)
fi
if [[ ${precmd_functions[(I)__inari_precmd_hook]} -eq 0 ]]; then
    precmd_functions+=(__inari_precmd_hook)
fi
