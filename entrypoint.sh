#!/bin/sh
set -e

echo "1claw runtime-base starting (runtime_id=${ONECLAW_RUNTIME_ID:-unknown}, agent_id=${ONECLAW_AGENT_ID:-unknown})"

USER_PORT="${USER_PORT:-8000}"
# Cloud Run sets PORT for the ingress listener. Sidecar inbound binds here when enabled.
PUBLIC_PORT="${PORT:-8080}"

start_sidecar() {
  if [ ! -x /usr/local/bin/shroud-sidecar ]; then
    echo "WARN: shroud-sidecar binary not found; shell/inbound proxy disabled"
    return 0
  fi
  if [ "${ONECLAW_SIDECAR_ENABLED:-0}" != "1" ]; then
    echo "Sidecar disabled (set ONECLAW_SIDECAR_ENABLED=1 to enable shell/inbound)"
    return 0
  fi

  export USER_PORT
  export INBOUND_ADDR=":${PUBLIC_PORT}"
  # Privileged sidecar APIs stay on loopback; only INBOUND_ADDR is public.
  export LISTEN_ADDR="127.0.0.1:8082"
  export INBOUND_AUTH="${INBOUND_AUTH:-public}"
  export ONECLAW_JWKS_URL="${ONECLAW_JWKS_URL:-https://api.1claw.co/.well-known/jwks.json}"
  export ONECLAW_BASE_URL="${ONECLAW_BASE_URL:-https://api.1claw.co}"
  # Shell-only unless agent credentials are present (avoids fatal on missing API key).
  if [ -z "${ONECLAW_AGENT_API_KEY:-}" ] && [ -z "${ONECLAW_AGENT_TOKEN:-}" ]; then
    export ONECLAW_SHELL_ONLY=1
  fi

  echo "Starting shroud-sidecar (inbound :${PUBLIC_PORT} → user :${USER_PORT}, terminal /terminal)"
  /usr/local/bin/shroud-sidecar &
  SIDECAR_PID=$!
  # Give sidecar a moment; user process is the long-lived child below.
  sleep 0.2
  echo "Sidecar pid=${SIDECAR_PID}"
}

# Clone source repository if provided
if [ -n "$SOURCE_REPO" ]; then
  case "$SOURCE_REPO" in
    https://*|git://*|git@*) ;;
    *) echo "ERROR: SOURCE_REPO must be https://, git://, or git@"; exit 1 ;;
  esac
  BRANCH="${SOURCE_BRANCH:-main}"
  case "$BRANCH" in
    -*|*".."*|*" "*) echo "ERROR: invalid SOURCE_BRANCH"; exit 1 ;;
  esac
  echo "Cloning source from ${SOURCE_REPO} (branch: ${BRANCH})..."
  git clone --depth 1 --branch "$BRANCH" -- "$SOURCE_REPO" /app/workspace/src
  cd /app/workspace/src

  if [ -f requirements.txt ]; then
    echo "Installing Python dependencies..."
    python -m venv /app/.venv 2>/dev/null || true
    if [ -f /app/.venv/bin/pip ]; then
      /app/.venv/bin/pip install --no-cache-dir -r requirements.txt
    else
      pip install --no-cache-dir --user -r requirements.txt 2>/dev/null || true
    fi
  fi

  if [ -f package.json ]; then
    echo "Installing Node.js dependencies..."
    npm install --omit=dev
  fi
else
  cd /app/workspace

  if [ -f package.json ]; then
    echo "Detected Node.js project, installing dependencies..."
    npm install --omit=dev 2>/dev/null || true
  fi

  if [ -f requirements.txt ]; then
    echo "Detected Python project, installing dependencies..."
    python -m venv /app/.venv 2>/dev/null || true
    if [ -f /app/.venv/bin/pip ]; then
      /app/.venv/bin/pip install --no-cache-dir -r requirements.txt
    else
      pip install --no-cache-dir --user -r requirements.txt 2>/dev/null || true
    fi
  fi
fi

if [ -n "$ONECLAW_AGENT_API_KEY" ]; then
    export ONECLAW_AGENT_API_KEY
fi

start_sidecar

# User process must listen on USER_PORT (sidecar proxies public PORT → USER_PORT).
export PORT="$USER_PORT"

run_user() {
  if [ -n "$STARTUP_COMMAND" ]; then
    echo "Running startup command via sh -c (argv-safe)"
    # Quote the whole command as a single -c argument (never unquoted exec).
    exec /bin/sh -c "$STARTUP_COMMAND"
  fi

  if [ -f entrypoint.sh ]; then
    exec ./entrypoint.sh
  elif [ -f agent.ts ]; then
    exec npx tsx agent.ts
  elif [ -f agent.js ]; then
    exec node agent.js
  elif [ -f agent.py ]; then
    if [ -f /app/.venv/bin/python ]; then
      exec /app/.venv/bin/python agent.py
    else
      exec python agent.py
    fi
  elif [ -f main.py ]; then
    if [ -f /app/.venv/bin/python ]; then
      exec /app/.venv/bin/python main.py
    else
      exec python main.py
    fi
  elif [ -f app.py ]; then
    if [ -f /app/.venv/bin/python ]; then
      exec /app/.venv/bin/python app.py
    else
      exec python app.py
    fi
  elif [ -f index.ts ]; then
    exec npx tsx index.ts
  elif [ -f index.js ]; then
    exec node index.js
  else
    echo "No entrypoint found. Set STARTUP_COMMAND or add main.py/index.ts/agent.ts"
    exec node -e "
const http = require('http');
const port = process.env.PORT || 8000;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); }
  else { res.writeHead(404); res.end('not found'); }
}).listen(port, () => console.log('Health server on port ' + port));
"
  fi
}

run_user
