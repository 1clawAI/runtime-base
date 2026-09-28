#!/bin/sh
# Start Hermes Agent with 1Claw integration (1clawAI/1claw-hermes).
# Dashboard chat uses chat-bridge on USER_PORT; this runs the Hermes agent process.
set -e

export HOME="${HOME:-/app}"
export HERMES_CONFIG_DIR="${HERMES_CONFIG_DIR:-${HOME}/.hermes}"
export HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
mkdir -p "$HERMES_CONFIG_DIR"

# A non-root Hermes install puts the command in $HERMES_HOME/bin, which older
# images never added to PATH — so `command -v hermes` failed below, this script
# slept forever, and chat quietly used the native-agent fallback instead of
# Hermes. The Dockerfile now sets this too; keep it here so an image built
# before that fix still finds a Hermes that is actually installed.
case ":${PATH}:" in
  *":${HERMES_HOME}/bin:"*) ;;
  *) PATH="${HERMES_HOME}/bin:${PATH}"; export PATH ;;
esac

# ---------------------------------------------------------------------------
# MCP credential relay.
#
# 1claw-hermes writes Hermes' MCP config once, with a literal
# `Authorization: Bearer <jwt>` in it. That JWT is the runtime's ~2h agent
# token, and a bearer baked into a config file cannot be refreshed — so when it
# expired, every MCP call 401'd, Hermes parked the server after three attempts,
# and the agent silently lost the entire 1claw toolset while still answering.
# The user's only remedy was to restart the runtime.
#
# Pointing ONECLAW_MCP_URL at a loopback relay *before* that config is written
# means the baked bearer is replaced on every request with a live one. Hermes'
# config never changes and never needs to.
#
# Kept in a respawn loop: if the relay dies, Hermes loses MCP entirely, which
# would be worse than the problem being fixed.
if [ -f /app/mcp-auth-relay.js ]; then
  ONECLAW_MCP_RELAY_PORT="${ONECLAW_MCP_RELAY_PORT:-8766}"
  # Capture the real endpoint before overriding the variable Hermes reads.
  ONECLAW_MCP_UPSTREAM_URL="${ONECLAW_MCP_UPSTREAM_URL:-${ONECLAW_MCP_URL:-https://mcp.1claw.co/mcp}}"
  export ONECLAW_MCP_RELAY_PORT ONECLAW_MCP_UPSTREAM_URL
  (
    while true; do
      node /app/mcp-auth-relay.js || echo "WARN: mcp-auth-relay exited, restarting" >&2
      sleep 2
    done
  ) &
  export ONECLAW_MCP_URL="http://127.0.0.1:${ONECLAW_MCP_RELAY_PORT}/mcp"
  echo "hermes-agent-start: MCP requests relayed via ${ONECLAW_MCP_URL} so the agent JWT stays live" >&2
else
  echo "WARN: mcp-auth-relay.js not present — Hermes' MCP bearer will expire with the agent token (restart needed)" >&2
fi

# Anthropic without a stored key.
#
# When the agent has OIDC federation enabled for Anthropic, the vault sets
# ONECLAW_ANTHROPIC_OIDC=1 and this starts a loopback relay that mints an
# `sk-ant-oat01-...` from the runtime's own identity and attaches it per
# request. Hermes reads ANTHROPIC_API_KEY once at start and a federated token
# is short-lived by design, so injecting one at boot would be wrong within the
# hour — same reason the MCP relay above exists.
#
# Not started when Shroud is routing: there the sidecar holds the provider
# credential and LLM traffic already goes through 127.0.0.1:8082, so a second
# credential path would be two answers to one question.
if [ "${ONECLAW_ANTHROPIC_OIDC:-}" = "1" ] && [ "${ONECLAW_SHROUD_ENABLED:-}" != "1" ]; then
  if [ -f /app/anthropic-relay.js ]; then
    ONECLAW_ANTHROPIC_RELAY_PORT="${ONECLAW_ANTHROPIC_RELAY_PORT:-8767}"
    export ONECLAW_ANTHROPIC_RELAY_PORT
    (
      while true; do
        node /app/anthropic-relay.js || echo "WARN: anthropic-relay exited, restarting" >&2
        sleep 2
      done
    ) &
    export ANTHROPIC_BASE_URL="http://127.0.0.1:${ONECLAW_ANTHROPIC_RELAY_PORT}"
    # Hermes requires the variable to be set; the relay replaces it per
    # request, so the value is a placeholder and never a credential.
    export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-oidc-federated}"
    echo "hermes-agent-start: Anthropic via OIDC federation — no stored key (${ANTHROPIC_BASE_URL})" >&2
  else
    echo "WARN: ONECLAW_ANTHROPIC_OIDC=1 but anthropic-relay.js is not present — rebuild the runtime to pick it up" >&2
  fi
fi

echo "hermes-agent-start: applying 1claw-hermes runtime integration..." >&2

if command -v 1claw-hermes-runtime-start >/dev/null 2>&1; then
  1claw-hermes-runtime-start || echo "WARN: 1claw-hermes-runtime-start failed (continuing)" >&2
elif [ -f /opt/1claw-hermes/dist/runtime-start.js ]; then
  node /opt/1claw-hermes/dist/runtime-start.js || echo "WARN: runtime-start.js failed (continuing)" >&2
else
  echo "WARN: 1claw-hermes not installed — Hermes will start without 1Claw MCP patch" >&2
fi

if ! command -v hermes >/dev/null 2>&1; then
  echo "WARN: hermes CLI not found — integration patch applied; install Hermes or use Terminal" >&2
  exec sleep infinity
fi

# ---------------------------------------------------------------------------
# Native dashboard chat → Hermes' own OpenAI-compatible API server.
#
# `hermes gateway` (below) can expose an OpenAI-compatible HTTP API on loopback
# :8642 that runs the SAME agent as the Terminal TUI — same configured model,
# MCP toolset, skills and profile-global memory (MEMORY.md / USER.md). The 1Claw
# bridge (native-agent-server.js) proxies dashboard chat to it ("native" mode)
# so the dashboard answers as the Hermes model (e.g. claude-opus-4.6 via the
# Shroud sidecar) instead of the bridge's own gpt-4o loop, and both surfaces
# share one agent memory. If the API server isn't reachable (older image, or the
# token below is missing), the bridge's health probe transparently falls back to
# its own tool-enabled agent loop — so enabling it here is safe and non-fatal.
#
# Auth handoff mirrors OpenClaw: hermes-native-setup.js writes a 0600 token file;
# we read it and hand it to Hermes as API_SERVER_KEY, and the bridge reads the
# same file (resolveHermesToken) in its own process, so their bearers match. The
# token value is never echoed. Env vars take precedence over ~/.hermes config.
API_SERVER_HOST="${API_SERVER_HOST:-127.0.0.1}"
API_SERVER_PORT="${API_SERVER_PORT:-8642}"
export API_SERVER_HOST API_SERVER_PORT

if [ -f /app/hermes-native-setup.js ]; then
  node /app/hermes-native-setup.js || echo "WARN: hermes-native-setup.js failed (API server will run without a key)" >&2
fi
HERMES_TOKEN_FILE="${ONECLAW_HERMES_TOKEN_FILE:-${HERMES_CONFIG_DIR:-${HOME}/.hermes}/native-loopback-token}"
if [ -f "$HERMES_TOKEN_FILE" ]; then
  HERMES_API_SERVER_KEY="$(cat "$HERMES_TOKEN_FILE" 2>/dev/null | tr -d '\n\r')"
  if [ -n "$HERMES_API_SERVER_KEY" ]; then
    export API_SERVER_ENABLED="${API_SERVER_ENABLED:-true}"
    export API_SERVER_KEY="${API_SERVER_KEY:-$HERMES_API_SERVER_KEY}"
    echo "hermes-agent-start: Hermes API server enabled on ${API_SERVER_HOST}:${API_SERVER_PORT} (native dashboard chat)" >&2
  else
    echo "WARN: native-loopback-token empty — Hermes API server not enabled; dashboard chat will use the 1Claw bridge" >&2
  fi
else
  echo "WARN: no native-loopback-token — Hermes API server not enabled; dashboard chat will use the 1Claw bridge" >&2
fi

# Respect env toggles from dashboard wizard (ENABLE_SHROUD, etc. are already on the container).
if [ "${HERMES_START_GATEWAY:-1}" = "1" ]; then
  echo "hermes-agent-start: launching hermes gateway" >&2
  exec hermes gateway
fi

echo "hermes-agent-start: launching hermes (HERMES_START_GATEWAY=0)" >&2
exec hermes
