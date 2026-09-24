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

# Respect env toggles from dashboard wizard (ENABLE_SHROUD, etc. are already on the container).
if [ "${HERMES_START_GATEWAY:-1}" = "1" ]; then
  echo "hermes-agent-start: launching hermes gateway" >&2
  exec hermes gateway
fi

echo "hermes-agent-start: launching hermes (HERMES_START_GATEWAY=0)" >&2
exec hermes
