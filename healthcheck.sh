#!/bin/sh
curl -sf "http://localhost:${PORT:-8080}/health" || exit 1
