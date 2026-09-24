ARG REGISTRY=us-west1-docker.pkg.dev/pacific-cab-487716-k1/oneclaw
FROM ${REGISTRY}/runtime-base:latest

USER root

# Fail the build if base image lacks the shell sidecar (stale runtime-base:latest).
RUN test -x /usr/local/bin/shroud-sidecar

# CLI_VERSION + CLI_CACHEBUST invalidate the npm layer so rebuilds fetch @latest from the registry.
ARG CLI_VERSION=latest
ARG CLI_CACHEBUST=1
ARG ONECLAW_HERMES_REF=main
ARG HERMES_AGENT_INSTALL=1

# Global CLI for interactive shell (1claw --help, secret pull, etc.)
RUN echo "Installing @1claw/cli@${CLI_VERSION} (cachebust=${CLI_CACHEBUST})" && \
    npm install -g "@1claw/cli@${CLI_VERSION}"

COPY shared/fix-esm-imports.mjs /tmp/fix-esm-imports.mjs

# 1claw-hermes integration package (github.com/1clawAI/1claw-hermes)
# Base image sets NODE_ENV=production; --include=dev installs typescript + @types/node for tsc.
RUN echo "Installing 1claw-hermes@${ONECLAW_HERMES_REF}" && \
    git clone --depth 1 --branch "${ONECLAW_HERMES_REF}" \
      https://github.com/1clawAI/1claw-hermes.git /opt/1claw-hermes && \
    cd /opt/1claw-hermes && npm install --include=dev && npm run build && \
    npm install -g /opt/1claw-hermes && \
    node /tmp/fix-esm-imports.mjs \
      /opt/1claw-hermes/node_modules/@1claw/sdk \
      "$(npm root -g)/@workspace/1claw-hermes/node_modules/@1claw/sdk" && \
    node --input-type=module -e "import('/opt/1claw-hermes/node_modules/@1claw/sdk/dist/index.js').then(m=>{if(typeof m.createClient!=='function')throw new Error('createClient missing');console.log('@1claw/sdk import OK')}).catch(e=>{console.error(e);process.exit(1)})"

# Hermes Agent CLI (hermes gateway, MCP host) — install as appuser under ~/.hermes.
#
# HERMES_HOME and PATH are set BEFORE the install, not after, for two reasons:
#
#  1. A non-root install puts the command in $HERMES_HOME/bin (the installer's
#     UV_TOOL_BIN_DIR), NOT in ~/.local/bin. That directory was never on PATH,
#     so a perfectly successful install produced a container where
#     `command -v hermes` failed — hermes-agent-start.sh then logged
#     "hermes CLI not found", `exec sleep infinity`, and dashboard chat
#     silently fell through to the native-agent fallback. The runtime looked
#     healthy and was not running Hermes at all.
#  2. The installer reads HERMES_HOME to decide where to put things, so it has
#     to be set at install time rather than only at runtime.
ENV HOME=/app
ENV HERMES_CONFIG_DIR=/app/.hermes
ENV HERMES_HOME=/app/.hermes
ENV PATH="/app/.hermes/bin:/app/.local/bin:${PATH}"

# The Hermes installer compiles native Node modules (node-pty), so it needs a
# C++ toolchain. It tries to `apt install build-essential` itself, which cannot
# work here — the install runs as appuser, apt needs root — so it printed
#   "can't install a C++ compiler automatically"
# and aborted. The `|| echo WARN` below then swallowed that, which is how an
# agent-less image shipped for weeks. node:24-slim carries no compiler, so
# install one first, as root.
#
# Kept rather than purged afterwards: removing it in a later layer would not
# shrink the image anyway, and autoremove risks taking runtime libraries the
# freshly compiled .node files still link against.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/* \
    # The base image sets `ENV HOME=/app`, and ENV applies to every user — so
    # the `npm install -g` steps above, which run as root, create /app/.npm
    # owned by root. The Hermes installer then runs as appuser, cannot write
    # that cache, and npm dies with:
    #     npm error code EACCES
    #     npm error path /app/.npm/_cacache/tmp/...
    # It fails in about five seconds and, because the installer runs npm with
    # --silent and only prints its log when non-empty, prints nothing at all.
    # That is how this presented as "npm install failed or timed out" with no
    # cause, and how the image shipped without its agent for weeks.
    && mkdir -p /app/.npm /app/.local/bin \
    && chown -R appuser:appuser /app/.npm /app/.local

USER appuser
RUN if [ "${HERMES_AGENT_INSTALL}" = "1" ]; then \
      curl -fsSL https://hermes-agent.nousresearch.com/install.sh | \
        bash -s -- --skip-browser || \
      echo "WARN: Hermes Agent install failed — rebuild or install via Terminal"; \
    fi

# Fail the build rather than ship an image whose agent is missing.
#
# This is the same rule commit 7b77c154 ("stop images shipping without their
# agent") applied to the npm-installed templates — it used `npm ls -g`, which
# by construction could not cover Hermes, because Hermes installs via
# `curl | bash` into a Python venv. So Hermes kept the old
# install-or-shrug behaviour and kept shipping without its agent.
# Verify the command, not the install command's exit status.
RUN if [ "${HERMES_AGENT_INSTALL}" = "1" ]; then \
      command -v hermes >/dev/null 2>&1 || { \
        echo "FATAL: hermes CLI is not on PATH after install."; \
        echo "  Looked on: ${PATH}"; \
        echo "  Launcher expected at: ${HOME}/.local/bin/hermes"; \
        ls -la "${HOME}/.local/bin" 2>/dev/null || echo "  (${HOME}/.local/bin does not exist)"; \
        ls -la "${HERMES_HOME}/bin" 2>/dev/null || echo "  (${HERMES_HOME}/bin does not exist)"; \
        echo "--- reproducing the installer's Node step with output visible ---"; \
        echo "    (it runs `npm install --silent` and discards the log when empty,"; \
        echo "     so the only way to see the real error is to run it ourselves)"; \
        if [ -d "${HERMES_HOME}/hermes-agent" ]; then \
          cd "${HERMES_HOME}/hermes-agent" && \
          (npm install --workspaces=false 2>&1 | tail -40) || true; \
        else \
          echo "    (${HERMES_HOME}/hermes-agent does not exist — install died earlier)"; \
        fi; \
        echo "--- end Node step diagnostics ---"; \
        echo "  Build with --build-arg HERMES_AGENT_INSTALL=0 to ship a Hermes-less image deliberately."; \
        exit 1; \
      }; \
      echo "hermes CLI verified at $(command -v hermes)"; \
    fi
USER root

RUN cd /app/workspace && \
    npm install --save \
      @1claw/sdk \
      @1claw/mcp \
      "@1claw/cli@${CLI_VERSION}" \
      zod \
      axios \
      dotenv \
    && node /tmp/fix-esm-imports.mjs /app/workspace/node_modules/@1claw/sdk \
    && chown -R appuser:appuser /app/workspace /opt/1claw-hermes /app/.hermes 2>/dev/null || \
    chown -R appuser:appuser /app/workspace /opt/1claw-hermes

USER appuser

# HOME / HERMES_CONFIG_DIR / HERMES_HOME / PATH are set above, before the
# install, so the installer and the running container agree on the layout.

WORKDIR /app/workspace

COPY hermes/entrypoint.sh /app/template-entrypoint.sh
COPY shared/chat-bridge.js /app/chat-bridge.js
COPY shared/1claw-capabilities-prompt.js /app/1claw-capabilities-prompt.js
COPY shared/agent-token.js /app/agent-token.js
COPY shared/native-agent-server.js /app/native-agent-server.js
COPY shared/image-gen.js /app/image-gen.js
COPY shared/image-gen-request.js /app/image-gen-request.js
COPY shared/generated-image-cache.js /app/generated-image-cache.js
COPY shared/message-sanitize.js /app/message-sanitize.js
COPY shared/fix-esm-imports.mjs /app/fix-esm-imports.mjs
COPY shared/user-port.sh /app/user-port.sh
COPY shared/hermes-agent-start.sh /app/hermes-agent-start.sh
COPY shared/tools/ /app/tools/
COPY hermes/tools-config.js /app/tools-config.js
USER root
ENV ENABLE_CODE_EXEC=true
RUN chmod +x /app/template-entrypoint.sh /app/user-port.sh /app/hermes-agent-start.sh \
    && chown appuser:appuser /app/chat-bridge.js /app/1claw-capabilities-prompt.js /app/agent-token.js /app/native-agent-server.js /app/image-gen.js /app/image-gen-request.js /app/generated-image-cache.js /app/message-sanitize.js \
       /app/user-port.sh /app/hermes-agent-start.sh /app/tools/ /app/tools-config.js
USER appuser

CMD ["/app/template-entrypoint.sh"]
