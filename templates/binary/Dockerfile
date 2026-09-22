ARG REGISTRY=us-west1-docker.pkg.dev/pacific-cab-487716-k1/oneclaw
FROM ${REGISTRY}/runtime-base:latest

# A plain compiled program (Go, Rust, anything static or glibc-linked on
# linux/amd64), with the 1Claw CLI, curl, git and the shell sidecar from the
# base image and nothing else. The program comes from BINARY_URL (a release
# asset, optionally pinned by BINARY_SHA256) or from STARTUP_COMMAND after a
# SOURCE_REPO clone. Nanobots plan, item 10.

USER root
RUN test -x /usr/local/bin/shroud-sidecar
RUN mkdir -p /app/workspace/bin && chown -R appuser:appuser /app/workspace

COPY binary/entrypoint.sh /app/template-entrypoint.sh
RUN chmod +x /app/template-entrypoint.sh

USER appuser
WORKDIR /app/workspace
