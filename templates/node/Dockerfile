ARG REGISTRY=us-west1-docker.pkg.dev/pacific-cab-487716-k1/oneclaw
FROM ${REGISTRY}/runtime-base:latest

USER root

# Fail the build if base image lacks the shell sidecar (stale runtime-base:latest).
RUN test -x /usr/local/bin/shroud-sidecar

COPY shared/fix-esm-imports.mjs /tmp/fix-esm-imports.mjs

RUN npm install -g typescript tsx && \
    mkdir -p /app/workspace/node_modules && \
    cd /app/workspace && \
    npm install --save \
      @1claw/sdk \
      zod \
      axios \
      dotenv \
    && node /tmp/fix-esm-imports.mjs /app/workspace/node_modules/@1claw/sdk \
    && chown -R appuser:appuser /app/workspace

USER appuser

WORKDIR /app/workspace

COPY node/entrypoint.sh /app/template-entrypoint.sh
USER root
RUN chmod +x /app/template-entrypoint.sh
USER appuser

CMD ["/app/template-entrypoint.sh"]
