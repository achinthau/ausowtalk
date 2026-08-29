#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Stopping the CRM server"
lsof -ti tcp:8080 2>/dev/null | xargs kill 2>/dev/null || true

echo "==> Stopping Asterisk"
docker compose -f "$ROOT/asterisk/docker-compose.yml" down

echo "Done."
