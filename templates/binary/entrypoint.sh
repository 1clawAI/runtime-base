#!/bin/sh
set -e

echo "1claw runtime-binary starting (runtime_id=${ONECLAW_RUNTIME_ID:-unknown}, agent_id=${ONECLAW_AGENT_ID:-unknown})"

cd /app/workspace

USER_PORT="${USER_PORT:-8000}"
PUBLIC_PORT="${PORT:-8080}"

if [ "${ONECLAW_SIDECAR_ENABLED:-0}" = "1" ]; then
  if [ -x /usr/local/bin/shroud-sidecar ]; then
    export USER_PORT
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
    echo "WARN: ONECLAW_SIDECAR_ENABLED=1 but shroud-sidecar is missing"
  fi
fi

export PORT="$USER_PORT"

if [ -n "${SOURCE_REPO:-}" ]; then
  echo "Cloning source from ${SOURCE_REPO} (branch: ${SOURCE_BRANCH:-main})..."
  git clone --depth 1 --branch "${SOURCE_BRANCH:-main}" "$SOURCE_REPO" /app/workspace/src
  cd /app/workspace/src
fi

# A release asset: fetched over HTTPS only, pinned by BINARY_SHA256 when
# given (a mismatch is fatal — a runtime that silently ran a different
# binary than the one you approved is worse than one that did not start).
if [ -n "${BINARY_URL:-}" ]; then
  case "$BINARY_URL" in
    https://*) ;;
    *) echo "BINARY_URL must be https://"; exit 78 ;;
  esac
  echo "Fetching ${BINARY_URL}..."
  curl -fsSL --retry 3 --max-time 300 -o /app/workspace/bin/app "$BINARY_URL"
  if [ -n "${BINARY_SHA256:-}" ]; then
    actual=$(sha256sum /app/workspace/bin/app | cut -d' ' -f1)
    if [ "$actual" != "$BINARY_SHA256" ]; then
      echo "BINARY_SHA256 mismatch: expected ${BINARY_SHA256}, got ${actual}"
      exit 78
    fi
    echo "Binary checksum verified"
  else
    echo "WARN: BINARY_SHA256 not set — the fetched binary is not pinned"
  fi
  # A tarball or zip: unpack, then the command decides what to run.
  case "$BINARY_URL" in
    *.tar.gz|*.tgz) mkdir -p /app/workspace/bin/unpacked && tar -xzf /app/workspace/bin/app -C /app/workspace/bin/unpacked && echo "Unpacked to /app/workspace/bin/unpacked" ;;
    *.zip) mkdir -p /app/workspace/bin/unpacked && python3 -c "import zipfile;zipfile.ZipFile('/app/workspace/bin/app').extractall('/app/workspace/bin/unpacked')" && echo "Unpacked to /app/workspace/bin/unpacked" ;;
    *) chmod +x /app/workspace/bin/app ;;
  esac
fi

if [ -n "${STARTUP_COMMAND:-}" ]; then
  echo "Running: $STARTUP_COMMAND"
  exec sh -c "$STARTUP_COMMAND"
elif [ -x /app/workspace/bin/app ]; then
  echo "Running: /app/workspace/bin/app"
  exec /app/workspace/bin/app
else
  echo "Nothing to run. Set BINARY_URL (a release asset) or STARTUP_COMMAND (after SOURCE_REPO)."
  exit 78
fi
