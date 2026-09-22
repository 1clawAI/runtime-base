#!/bin/sh
set -e

echo "1claw runtime-python starting (runtime_id=${ONECLAW_RUNTIME_ID:-unknown}, agent_id=${ONECLAW_AGENT_ID:-unknown})"

export PYTHONUNBUFFERED=1

cd /app/workspace

USER_PORT="${USER_PORT:-8000}"
PUBLIC_PORT="${PORT:-8080}"

# Sidecar as Cloud Run ingress when shell/proxy is enabled.
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

if [ -n "$SOURCE_REPO" ]; then
  echo "Cloning source from ${SOURCE_REPO} (branch: ${SOURCE_BRANCH:-main})..."
  git clone --depth 1 --branch "${SOURCE_BRANCH:-main}" "$SOURCE_REPO" /app/workspace/src
  cd /app/workspace/src
fi

if [ -f requirements.txt ]; then
  echo "Installing requirements.txt..."
  pip install --no-cache-dir -r requirements.txt
fi

if [ -n "$STARTUP_COMMAND" ]; then
  echo "Running: $STARTUP_COMMAND"
  exec sh -c "$STARTUP_COMMAND"
elif [ -f main.py ]; then
  exec python -u main.py
elif [ -f app.py ]; then
  exec python -u app.py
elif [ -f agent.py ]; then
  exec python -u agent.py
else
  echo "No Python entrypoint found. Set STARTUP_COMMAND or add main.py/app.py/agent.py"
  exec node -e "
const http = require('http');
const port = process.env.PORT || 8000;
http.createServer((req, res) => {
  console.log(new Date().toISOString(), req.method, req.url);
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); }
  else { res.writeHead(404); res.end('not found'); }
}).listen(port, () => console.log('Health server on port ' + port));
"
fi
