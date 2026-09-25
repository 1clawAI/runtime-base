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
# In-container native chat adapter (1clawAI/1claw-hermes).
#
# The adapter is an OpenAI-compatible SSE server on loopback :8778 that the
# 1Claw bridge (native-agent-server.js) proxies dashboard chat to when it's
# healthy ("native" mode). It runs ALONGSIDE `hermes gateway` (below) — it does
# not replace it. If the adapter isn't present (image built before it shipped)
# or fails to come up, the bridge's reachability probe simply falls back to its
# own tool-enabled agent loop, so this launch is best-effort and never fatal.
#
# Token handoff mirrors OpenClaw: hermes-native-setup.js writes a 0600 token
# file, we read it and export ONECLAW_HERMES_NATIVE_TOKEN for the adapter, and
# the bridge reads the same file (resolveHermesToken) in its own process.
ONECLAW_HERMES_NATIVE_HOST="${ONECLAW_HERMES_NATIVE_HOST:-127.0.0.1}"
ONECLAW_HERMES_NATIVE_PORT="${ONECLAW_HERMES_NATIVE_PORT:-8778}"
export ONECLAW_HERMES_NATIVE_HOST ONECLAW_HERMES_NATIVE_PORT

# The `hermes` completion invocation the adapter shells out to.
#
#   !!! UNVERIFIED PLACEHOLDER !!!
#   Hermes (Nous Research) exposes NO documented one-shot chat/completion CLI.
#   The args below are a plausible stdin-prompt/stdout-text contract that has
#   NOT been validated against a real `hermes` binary. Native-hermes chat MUST
#   be validated in a rebuilt runtime before it is trusted; until then the
#   bridge health-probe fallback protects existing runtimes. Override at runtime
#   with ONECLAW_HERMES_CLI / ONECLAW_HERMES_CLI_ARGS (JSON array) once the real
#   invocation is known — no image rebuild required to correct it.
export ONECLAW_HERMES_CLI="${ONECLAW_HERMES_CLI:-hermes}"
export ONECLAW_HERMES_CLI_ARGS="${ONECLAW_HERMES_CLI_ARGS:-[\"run\",\"--json\",\"--stream\"]}"

ONECLAW_HERMES_ADAPTER_ENTRY="${ONECLAW_HERMES_ADAPTER_ENTRY:-/opt/1claw-hermes/dist/adapter/serve.js}"
if [ -f "$ONECLAW_HERMES_ADAPTER_ENTRY" ]; then
  if [ -f /app/hermes-native-setup.js ]; then
    node /app/hermes-native-setup.js || echo "WARN: hermes-native-setup.js failed (adapter will run without a token)" >&2
  fi
  # Read the provisioned token into the adapter's env (never echo the value).
  HERMES_TOKEN_FILE="${ONECLAW_HERMES_TOKEN_FILE:-${HERMES_CONFIG_DIR:-${HOME}/.hermes}/native-loopback-token}"
  if [ -z "${ONECLAW_HERMES_NATIVE_TOKEN:-}" ] && [ -f "$HERMES_TOKEN_FILE" ]; then
    ONECLAW_HERMES_NATIVE_TOKEN="$(cat "$HERMES_TOKEN_FILE" 2>/dev/null | tr -d '\n\r')"
    export ONECLAW_HERMES_NATIVE_TOKEN
  fi
  echo "hermes-agent-start: launching 1claw-hermes adapter on ${ONECLAW_HERMES_NATIVE_HOST}:${ONECLAW_HERMES_NATIVE_PORT}" >&2
  node "$ONECLAW_HERMES_ADAPTER_ENTRY" &
else
  echo "WARN: 1claw-hermes adapter not found at ${ONECLAW_HERMES_ADAPTER_ENTRY} — native chat will fall back to the 1Claw bridge" >&2
fi

# Respect env toggles from dashboard wizard (ENABLE_SHROUD, etc. are already on the container).
if [ "${HERMES_START_GATEWAY:-1}" = "1" ]; then
  echo "hermes-agent-start: launching hermes gateway" >&2
  exec hermes gateway
fi

echo "hermes-agent-start: launching hermes (HERMES_START_GATEWAY=0)" >&2
exec hermes
