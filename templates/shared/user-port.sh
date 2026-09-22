# Shared helpers for chat-template runtimes (hermes / openclaw / openclaude / opencode).
# Sourced from template entrypoint.sh — keeps chat-bridge on USER_PORT even when
# STARTUP_COMMAND is set (sidecar reverse-proxies to USER_PORT for /v1/chat/*).
#
# Contract: start_user_port_listener prints ONLY the PID on stdout.
# All diagnostic messages go to stderr so `USER_PID=$(...)` stays numeric.

# Probe GET /health or /healthz on loopback USER_PORT (exit 0 = healthy).
_probe_user_port_health() {
  node -e "
const http = require('http');
const port = Number(process.env.USER_PORT || 8000);
const paths = ['/health', '/healthz'];
let settled = false;
let pending = paths.length;
function finish(ok) {
  if (settled) return;
  settled = true;
  process.exit(ok ? 0 : 1);
}
for (const path of paths) {
  const req = http.get({ hostname: '127.0.0.1', port, path, timeout: 1500 }, (res) => {
    if (res.statusCode >= 200 && res.statusCode < 300) finish(true);
    else if (--pending === 0) finish(false);
  });
  req.on('error', () => { if (--pending === 0) finish(false); });
  req.on('timeout', () => { req.destroy(); if (--pending === 0) finish(false); });
}
" 2>/dev/null
}

# Wait until pid is alive and USER_PORT responds, or timeout (exit 1).
_wait_pid_user_port_health() {
  pid="$1"
  timeout="${2:-15}"
  elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    if _probe_user_port_health; then
      return 0
    fi
    elapsed=$((elapsed + 1))
    sleep 1
  done
  return 1
}

_start_chat_bridge_or_stub() {
  framework="$1"
  export PORT="${USER_PORT:-8000}"

  if [ -f /app/chat-bridge.js ]; then
    echo "${framework} runtime: starting chat bridge on port ${PORT} (LLM proxy only)" >&2
    node /app/chat-bridge.js &
  else
    echo "WARN: neither native-agent-server.js nor chat-bridge.js found — health-only stub on port ${PORT}" >&2
    node -e "
const http = require('http');
const port = process.env.PORT || 8000;
const fw = process.env.ONECLAW_FRAMEWORK || 'hermes';
http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', framework: fw }));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(fw + ' health stub on port ' + port));
" &
  fi
  echo $!
}

# Start native-agent-server.js (preferred) or chat-bridge.js on USER_PORT.
# Native mode provides a full agent loop with tools, MCP, and memory.
# Falls back to chat-bridge immediately if native server exits or never binds.
# Prints PID to stdout.
start_user_port_listener() {
  export PORT="${USER_PORT:-8000}"
  framework="${ONECLAW_FRAMEWORK:-hermes}"

  # After a native crash, stick with chat-bridge for subsequent restarts.
  if [ "${ONECLAW_PREFER_CHAT_BRIDGE:-0}" = "1" ]; then
    _start_chat_bridge_or_stub "$framework"
    return
  fi

  # Prefer native agent server when available and agent credentials exist.
  if [ -f /app/native-agent-server.js ] && [ -n "${ONECLAW_AGENT_TOKEN:-}${ONECLAW_TOKEN:-}" ] && [ -n "${ONECLAW_VAULT_ID:-}" ]; then
    echo "${framework} runtime: starting NATIVE agent server on port ${PORT} (tools + memory + MCP)" >&2
    node /app/native-agent-server.js &
    native_pid=$!
    if _wait_pid_user_port_health "$native_pid" 15; then
      echo "$native_pid"
      return
    fi
    echo "WARN: native agent server failed to bind USER_PORT — falling back to chat-bridge" >&2
    kill "$native_pid" 2>/dev/null || true
    wait "$native_pid" 2>/dev/null || true
    export ONECLAW_PREFER_CHAT_BRIDGE=1
  fi

  _start_chat_bridge_or_stub "$framework"
}

# Poll /health or /healthz on USER_PORT so cold start does not accept chat before bind.
# Safe to call under set -e (temporarily disables errexit for the loop).
wait_for_user_port_health() {
  port="${USER_PORT:-8000}"
  timeout="${USER_PORT_HEALTH_TIMEOUT:-60}"
  echo "Waiting for user app health on 127.0.0.1:${port} (timeout ${timeout}s)..." >&2
  set +e
  elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if _probe_user_port_health; then
      echo "User app health check passed on port ${port}" >&2
      set -e
      return 0
    fi
    elapsed=$((elapsed + 1))
    if [ $((elapsed % 5)) -eq 0 ]; then
      echo "Still waiting for user app on :${port} (${elapsed}s)..." >&2
    fi
    sleep 1
  done
  echo "WARN: user app health check timed out after ${timeout}s — sidecar may return 502 until bridge is up" >&2
  set -e
  return 0
}

# Keep USER_PORT listener alive: restart on process exit or failed health probe.
supervise_user_port_listener() {
  USER_PID="$1"
  interval="${USER_PORT_SUPERVISOR_INTERVAL:-10}"

  while true; do
    if ! kill -0 "$USER_PID" 2>/dev/null; then
      echo "WARN: user port listener (pid=${USER_PID}) exited — restarting" >&2
    elif ! _probe_user_port_health; then
      echo "WARN: USER_PORT not responding (pid=${USER_PID}) — restarting listener" >&2
      kill "$USER_PID" 2>/dev/null || true
      wait "$USER_PID" 2>/dev/null || true
    else
      sleep "$interval"
      continue
    fi

    USER_PID=$(start_user_port_listener)
    case "$USER_PID" in
      ''|*[!0-9]*)
        echo "FATAL: failed to restart user port listener (got: ${USER_PID:-empty})" >&2
        exit 1
        ;;
    esac
    echo "user-port listener pid=${USER_PID}" >&2
    wait_for_user_port_health
  done
}
