ARG REGISTRY=us-west1-docker.pkg.dev/pacific-cab-487716-k1/oneclaw
FROM ${REGISTRY}/runtime-base:latest

USER root

# Fail the build if base image lacks the shell sidecar (stale runtime-base:latest).
RUN test -x /usr/local/bin/shroud-sidecar

# CLI_VERSION + CLI_CACHEBUST invalidate the npm layer so rebuilds fetch @latest from the registry.
# Pinnable agent version. Defaults to latest so behaviour is unchanged,
# but a build can pin it — an unpinned third-party CLI means any build can
# pull a different, possibly compromised release with nothing to compare
# against. The build workflow passes this through (AGENT_VERSION, set at
# the workflow level or per-run via workflow_dispatch).
ARG AGENT_VERSION=latest
ARG CLI_VERSION=latest
ARG CLI_CACHEBUST=1
ARG ONECLAW_OPENCLAW_PLUGIN_REF=main
ARG OPENCLAW_PLUGIN_VERSION=latest

# Global CLI for interactive shell (1claw --help, secret pull, etc.)
RUN echo "Installing @1claw/cli@${CLI_VERSION} + openclaw (cachebust=${CLI_CACHEBUST})" && \
    npm install -g "@1claw/cli@${CLI_VERSION}" "openclaw@${AGENT_VERSION}"

# Fail the build if the agent did not install. Until now this line was
# `... 2>/dev/null || true`, so a failed install produced an image with no
# agent in it and no error — which then looks like a runtime that starts
# and does nothing.
RUN npm ls -g --depth=0 openclaw > /dev/null

COPY shared/fix-esm-imports.mjs /tmp/fix-esm-imports.mjs

# @1claw/openclaw-plugin from github.com/1clawAI/1claw-openclaw-plugin
RUN echo "Installing 1claw-openclaw-plugin@${ONECLAW_OPENCLAW_PLUGIN_REF}" && \
    git clone --depth 1 --branch "${ONECLAW_OPENCLAW_PLUGIN_REF}" \
      https://github.com/1clawAI/1claw-openclaw-plugin.git /opt/1claw-openclaw-plugin && \
    npm install -g "openclaw@${AGENT_VERSION}"

RUN cd /app/workspace && \
    npm install --save \
      @1claw/sdk \
      @1claw/mcp \
      "@1claw/cli@${CLI_VERSION}" \
      "@1claw/openclaw-plugin@${OPENCLAW_PLUGIN_VERSION}" \
      zod \
      axios \
      dotenv \
    && node /tmp/fix-esm-imports.mjs /app/workspace/node_modules/@1claw/sdk \
    && chown -R appuser:appuser /app/workspace /opt/1claw-openclaw-plugin

USER appuser

ENV HOME=/app
ENV OPENCLAW_CONFIG_DIR=/app/.openclaw
ENV OPENCLAW_GATEWAY_PORT=18789

WORKDIR /app/workspace

COPY openclaw/entrypoint.sh /app/template-entrypoint.sh
COPY shared/chat-bridge.js /app/chat-bridge.js
COPY shared/1claw-capabilities-prompt.js /app/1claw-capabilities-prompt.js
COPY shared/agent-token.js /app/agent-token.js
COPY shared/native-agent-server.js /app/native-agent-server.js
COPY shared/image-gen.js /app/image-gen.js
COPY shared/image-gen-request.js /app/image-gen-request.js
COPY shared/generated-image-cache.js /app/generated-image-cache.js
COPY shared/message-sanitize.js /app/message-sanitize.js
COPY shared/user-port.sh /app/user-port.sh
COPY shared/openclaw-agent-start.sh /app/openclaw-agent-start.sh
COPY shared/openclaw-runtime-setup.js /app/openclaw-runtime-setup.js
COPY shared/tools/ /app/tools/
COPY openclaw/tools-config.js /app/tools-config.js
USER root
ENV ENABLE_CODE_EXEC=true
RUN chmod +x /app/template-entrypoint.sh /app/user-port.sh /app/openclaw-agent-start.sh \
    && chown appuser:appuser /app/chat-bridge.js /app/1claw-capabilities-prompt.js /app/agent-token.js /app/native-agent-server.js /app/image-gen.js /app/image-gen-request.js /app/generated-image-cache.js /app/message-sanitize.js /app/user-port.sh \
       /app/openclaw-agent-start.sh /app/openclaw-runtime-setup.js /app/tools/ /app/tools-config.js
USER appuser

CMD ["/app/template-entrypoint.sh"]
