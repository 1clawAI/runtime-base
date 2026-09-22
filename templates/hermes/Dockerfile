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

# Hermes Agent CLI (hermes gateway, MCP host) — install as appuser under ~/.hermes
USER appuser
RUN if [ "${HERMES_AGENT_INSTALL}" = "1" ]; then \
      curl -fsSL https://hermes-agent.nousresearch.com/install.sh | \
        bash -s -- --skip-browser || \
      echo "WARN: Hermes Agent install failed — rebuild or install via Terminal"; \
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

ENV HOME=/app
ENV HERMES_CONFIG_DIR=/app/.hermes
ENV HERMES_HOME=/app/.hermes
ENV PATH="/app/.local/bin:${PATH}"

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
