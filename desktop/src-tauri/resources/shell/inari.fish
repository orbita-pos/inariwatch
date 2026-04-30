# Inari Live — fish shell hook (Sensor 2, Session 9)
# Sourced from ~/.config/fish/config.fish when "Watch my terminal" is
# enabled. Forwards each command's metadata to the local daemon over
# a Unix domain socket. Privacy-scrubbing happens HERE, before any
# data leaves the shell. See ~/.inari/shell/README.md.

set -g __INARI_SOCK "$HOME/.inari/sock/shell.sock"

# Scrub env-var-shaped secrets:
# IDENT=value where IDENT contains KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD
# as an uppercase substring becomes IDENT=***.
function __inari_scrub
    sed -E 's/([A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)[A-Za-z0-9_]*)=[^[:space:]]+/\1=***/g'
end

function __inari_send
    set -l cmd $argv[1]
    set -l exit_code $argv[2]
    set -l duration_ms $argv[3]
    set -l cwd $PWD
    set -l timestamp (date +%s%3N 2>/dev/null; or echo 0)
    set cmd (printf '%s' "$cmd" | __inari_scrub)
    if type -q python3
        fish -c "python3 - '$__INARI_SOCK' '$cmd' '$cwd' '$exit_code' '$duration_ms' '$timestamp' <<'__INARI_PY' >/dev/null 2>&1 &
import socket, json, sys
sock_path, cmd, cwd, exit_code, duration_ms, timestamp = sys.argv[1:]
payload = json.dumps({
    'cmd':         cmd,
    'cwd':         cwd,
    'exit_code':   int(exit_code),
    'duration_ms': int(duration_ms),
    'timestamp':   int(timestamp),
})
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(0.3)
    s.connect(sock_path)
    s.sendall((payload + '\n').encode())
    s.close()
except Exception:
    pass
__INARI_PY
disown
" >/dev/null 2>&1
    end
end

set -g __inari_pre_cmd ""
set -g __inari_pre_t0 0

function __inari_preexec_hook --on-event fish_preexec
    set -g __inari_pre_cmd $argv[1]
    set -g __inari_pre_t0 (date +%s%3N 2>/dev/null; or echo 0)
end

function __inari_postexec_hook --on-event fish_postexec
    set -l exit_code $status
    if test -n "$__inari_pre_cmd"
        set -l now (date +%s%3N 2>/dev/null; or echo 0)
        set -l elapsed (math "$now - $__inari_pre_t0")
        if test $elapsed -lt 0
            set elapsed 0
        end
        __inari_send "$__inari_pre_cmd" "$exit_code" "$elapsed"
        set -g __inari_pre_cmd ""
    end
end
