#!/bin/sh
# Start OpenClaw gateway with @1claw/openclaw-plugin (1clawAI/1claw-openclaw-plugin).
# Dashboard chat uses chat-bridge on USER_PORT; gateway runs on OPENCLAW_GATEWAY_PORT.
set -e

export HOME="${HOME:-/app}"
export OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-${HOME}/.openclaw}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

mkdir -p "$OPENCLAW_CONFIG_DIR"

echo "openclaw-agent-start: configuring @1claw/openclaw-plugin..." >&2
if [ -f /app/openclaw-runtime-setup.js ]; then
  node /app/openclaw-runtime-setup.js
fi

if command -v openclaw >/dev/null 2>&1; then
  if [ -d /opt/1claw-openclaw-plugin ]; then
    openclaw plugins install -l /opt/1claw-openclaw-plugin 2>/dev/null || true
  else
    openclaw plugins install @1claw/openclaw-plugin 2>/dev/null || true
  fi
else
  echo "WARN: openclaw CLI not found" >&2
  exec sleep infinity
fi

echo "openclaw-agent-start: launching openclaw gateway on 127.0.0.1:${OPENCLAW_GATEWAY_PORT}" >&2
exec openclaw gateway --allow-unconfigured --bind loopback --port "${OPENCLAW_GATEWAY_PORT}"
