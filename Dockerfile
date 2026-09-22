# Build context must be packages/ (parent of runtime-base and 1claw-shroud-sidecar):
#   docker build -f runtime-base/Dockerfile -t runtime-base:latest .
FROM --platform=linux/amd64 golang:1.24-bookworm AS sidecar-builder
WORKDIR /src
COPY 1claw-shroud-sidecar/go.mod 1claw-shroud-sidecar/go.sum ./
RUN go mod download
COPY 1claw-shroud-sidecar/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /shroud-sidecar .

# Node 24 LTS: openclaw requires >=24.16 (22 is maintenance-only from 2026-10).
FROM --platform=linux/amd64 node:24-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    tini \
    python3 \
    python3-pip \
    python3-venv \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3 /usr/bin/python

# CLI_VERSION + CLI_CACHEBUST invalidate the npm layer so rebuilds fetch @latest from the registry
# (Docker otherwise caches `npm install -g @1claw/cli@latest` forever).
ARG CLI_VERSION=latest
ARG CLI_CACHEBUST=1
RUN echo "Installing @1claw/cli@${CLI_VERSION} (cachebust=${CLI_CACHEBUST})" && \
    npm install -g "@1claw/cli@${CLI_VERSION}" @1claw/mcp@latest 2>/dev/null || \
    echo "WARN: @1claw/cli/@1claw/mcp install deferred to runtime"

RUN adduser --disabled-password --gecos "" --home /app appuser

WORKDIR /app

# appuser home is /app (--home /app). Legacy templates referenced /home/appuser;
# create it owned by appuser so mkdir under ~/.hermes / ~/.openclaw never fails.
RUN mkdir -p /run/1claw /app/workspace /home/appuser /app/.local \
    && chown -R appuser:appuser /app /run/1claw /home/appuser

COPY --from=sidecar-builder /shroud-sidecar /usr/local/bin/shroud-sidecar
COPY runtime-base/entrypoint.sh /app/entrypoint.sh
COPY runtime-base/healthcheck.sh /app/healthcheck.sh
RUN chmod +x /app/entrypoint.sh /app/healthcheck.sh /usr/local/bin/shroud-sidecar

USER appuser

ENV HOME=/app
ENV NODE_ENV=production
ENV ONECLAW_DAEMON_SOCKET=/run/1claw/daemon.sock
ENV PORT=8080
ENV USER_PORT=8000

EXPOSE 8080 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
    CMD /app/healthcheck.sh

ENTRYPOINT ["tini", "--"]
CMD ["/app/entrypoint.sh"]
