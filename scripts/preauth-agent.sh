#!/bin/sh
# Source from template entrypoints after Vault injects ONECLAW_AGENT_TOKEN.
# Pre-authenticates CLI / SDK / MCP as the bound agent (no interactive login).

if [ -z "${ONECLAW_TOKEN:-}" ] && [ -n "${ONECLAW_AGENT_TOKEN:-}" ]; then
  export ONECLAW_TOKEN="$ONECLAW_AGENT_TOKEN"
fi

if [ -n "${ONECLAW_AGENT_TOKEN:-}" ] || [ -n "${ONECLAW_TOKEN:-}" ]; then
  # Sidecar uses this to decide whether agent credentials are present.
  unset ONECLAW_SHELL_ONLY
  export ONECLAW_API_URL="${ONECLAW_API_URL:-${ONECLAW_BASE_URL:-https://api.1claw.co}}"
  echo "1claw agent pre-auth ready (agent_id=${ONECLAW_AGENT_ID:-unknown})"
fi
