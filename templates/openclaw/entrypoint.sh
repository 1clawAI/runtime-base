#!/bin/sh
set -e

echo "1claw runtime-openclaw starting (runtime_id=${ONECLAW_RUNTIME_ID:-unknown}, agent_id=${ONECLAW_AGENT_ID:-unknown})"

cd /app/workspace

USER_PORT="${USER_PORT:-8000}"
PUBLIC_PORT="${PORT:-8080}"
export ONECLAW_FRAMEWORK="${ONECLAW_FRAMEWORK:-openclaw}"
export USER_PORT

# Vault injects ONECLAW_AGENT_TOKEN at start — wire CLI/SDK without interactive login.
if [ -z "${ONECLAW_TOKEN:-}" ] && [ -n "${ONECLAW_AGENT_TOKEN:-}" ]; then
  export ONECLAW_TOKEN="$ONECLAW_AGENT_TOKEN"
fi
if [ -n "${ONECLAW_AGENT_TOKEN:-}" ] || [ -n "${ONECLAW_TOKEN:-}" ]; then
  unset ONECLAW_SHELL_ONLY
  export ONECLAW_API_URL="${ONECLAW_API_URL:-${ONECLAW_BASE_URL:-https://api.1claw.co}}"
  echo "1claw agent pre-auth ready (agent_id=${ONECLAW_AGENT_ID:-unknown})"
fi

if [ "${ONECLAW_SIDECAR_ENABLED:-0}" = "1" ]; then
  if [ -x /usr/local/bin/shroud-sidecar ]; then
    export INBOUND_ADDR=":${PUBLIC_PORT}"
    export LISTEN_ADDR="127.0.0.1:8082"
    export INBOUND_AUTH="${INBOUND_AUTH:-api_key}"
    export ONECLAW_JWKS_URL="${ONECLAW_JWKS_URL:-https://api.1claw.co/.well-known/jwks.json}"
    export ONECLAW_BASE_URL="${ONECLAW_BASE_URL:-https://api.1claw.co}"
    if [ -z "${ONECLAW_AGENT_API_KEY:-}" ] && [ -z "${ONECLAW_AGENT_TOKEN:-}" ]; then
      export ONECLAW_SHELL_ONLY=1
    fi
    echo "Starting shroud-sidecar (inbound :${PUBLIC_PORT} → user :${USER_PORT})"
    /usr/local/bin/shroud-sidecar &
    sleep 0.2
  else
    echo "WARN: ONECLAW_SIDECAR_ENABLED=1 but /usr/local/bin/shroud-sidecar is missing — rebuild from a runtime-base that includes the sidecar"
  fi
fi

. /app/user-port.sh

# When running as a 1Claw cloud runtime, channels are managed by the platform.
# Native gateway channels are disabled to prevent duplicate bots connecting to
# the same Telegram/Discord/WhatsApp accounts.
if [ -n "${ONECLAW_AGENT_ID:-}" ]; then
  export OPENCLAW_DISABLE_CHANNELS=1
  export OPENCLAW_SLASH_COMMANDS=0
  echo "Platform agent detected — native OpenClaw channel connectors and slash commands disabled (use 1Claw Channels API)"
fi

# Default agent process: @1claw/openclaw-plugin + OpenClaw gateway (override via startup_command).
if [ -z "${STARTUP_COMMAND:-}" ]; then
  export STARTUP_COMMAND="/app/openclaw-agent-start.sh"
fi

if [ -n "${STARTUP_COMMAND:-}" ]; then
  echo "Running STARTUP_COMMAND in background: $STARTUP_COMMAND"
  sh -c "$STARTUP_COMMAND" &
fi

# start_user_port_listener prints ONLY a numeric PID on stdout (logs go to stderr).
USER_PID=$(start_user_port_listener)
case "$USER_PID" in
  ''|*[!0-9]*)
    echo "FATAL: start_user_port_listener did not return a PID (got: ${USER_PID:-empty})"
    exit 1
    ;;
esac
echo "user-port listener pid=${USER_PID}"
wait_for_user_port_health
supervise_user_port_listener "$USER_PID"
