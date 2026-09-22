ARG REGISTRY=us-west1-docker.pkg.dev/pacific-cab-487716-k1/oneclaw
FROM ${REGISTRY}/runtime-base:latest

USER root

# Fail the build if base image lacks the shell sidecar (stale runtime-base:latest).
RUN test -x /usr/local/bin/shroud-sidecar

RUN python -m venv /app/.venv && \
    /app/.venv/bin/pip install --no-cache-dir \
      langchain \
      openai \
      anthropic \
      numpy \
      requests \
      pydantic \
      httpx \
      python-dotenv \
    && chown -R appuser:appuser /app/.venv

USER appuser

ENV PATH="/app/.venv/bin:$PATH"
ENV VIRTUAL_ENV="/app/.venv"

WORKDIR /app/workspace

COPY python/entrypoint.sh /app/template-entrypoint.sh
USER root
RUN chmod +x /app/template-entrypoint.sh
USER appuser

CMD ["/app/template-entrypoint.sh"]
