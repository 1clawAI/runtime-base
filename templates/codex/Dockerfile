# OpenAI Codex CLI (Apache-2.0, open source). Requires a ChatGPT plan or an OPENAI_API_KEY at run time.
#
ARG REGISTRY=us-west1-docker.pkg.dev/pacific-cab-487716-k1/oneclaw
FROM ${REGISTRY}/runtime-base:latest

USER root

# Fail the build if base image lacks the shell sidecar (stale runtime-base:latest).
RUN test -x /usr/local/bin/shroud-sidecar

# Pinnable agent version. Defaults to latest so behaviour is unchanged,
# but a build can pin it — an unpinned third-party CLI means any build can
# pull a different, possibly compromised release with nothing to compare
# against. The build workflow passes this through (AGENT_VERSION, set at
# the workflow level or per-run via workflow_dispatch).
ARG AGENT_VERSION=latest
ARG CLI_VERSION=latest
ARG CLI_CACHEBUST=1

RUN echo "Installing @1claw/cli@${CLI_VERSION} + @openai/codex (cachebust=${CLI_CACHEBUST})" && \
    npm install -g "@1claw/cli@${CLI_VERSION}" "@openai/codex@${AGENT_VERSION}"

# Fail the build if the agent did not install. Until now this line was
# `... 2>/dev/null || true`, so a failed install produced an image with no
# agent in it and no error — which then looks like a runtime that starts
# and does nothing.
RUN npm ls -g --depth=0 @openai/codex > /dev/null

COPY shared/fix-esm-imports.mjs /tmp/fix-esm-imports.mjs

RUN cd /app/workspace && \
    npm install --save \
      @1claw/sdk \
      @1claw/mcp \
      "@1claw/cli@${CLI_VERSION}" \
      "@openai/codex@${AGENT_VERSION}" \
      zod \
      axios \
      dotenv \
    && node /tmp/fix-esm-imports.mjs /app/workspace/node_modules/@1claw/sdk \
    && mkdir -p /app/workspace/.codex/skills/1claw \
    && chown -R appuser:appuser /app/workspace

COPY codex/skills/1claw/SKILL.md /app/workspace/.codex/skills/1claw/SKILL.md
COPY codex/entrypoint.sh /app/template-entrypoint.sh
COPY shared/chat-bridge.js /app/chat-bridge.js
COPY shared/1claw-capabilities-prompt.js /app/1claw-capabilities-prompt.js
COPY shared/agent-token.js /app/agent-token.js
COPY shared/native-agent-server.js /app/native-agent-server.js
COPY shared/image-gen.js /app/image-gen.js
COPY shared/image-gen-request.js /app/image-gen-request.js
COPY shared/generated-image-cache.js /app/generated-image-cache.js
COPY shared/message-sanitize.js /app/message-sanitize.js
COPY shared/user-port.sh /app/user-port.sh
COPY shared/tools/ /app/tools/
COPY codex/tools-config.js /app/tools-config.js
RUN chmod +x /app/template-entrypoint.sh /app/user-port.sh \
    && chown -R appuser:appuser /app/workspace/.codex /app/template-entrypoint.sh /app/chat-bridge.js /app/1claw-capabilities-prompt.js /app/agent-token.js /app/native-agent-server.js /app/image-gen.js /app/image-gen-request.js /app/generated-image-cache.js /app/message-sanitize.js /app/user-port.sh /app/tools/ /app/tools-config.js

USER appuser
WORKDIR /app/workspace

CMD ["/app/template-entrypoint.sh"]
