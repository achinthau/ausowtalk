#!/usr/bin/env bash
#
# Bring the whole stack up: Asterisk (Docker) + the mock CRM server.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# ---- Preflight -------------------------------------------------------------

command -v docker >/dev/null || fail "docker is not installed"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not running — open Docker Desktop"
command -v node >/dev/null || fail "node is not installed (brew install node)"

if [ ! -f asterisk/certs/asterisk.crt ]; then
  info "No TLS certificate yet — generating one"
  ./scripts/make-certs.sh
fi

if [ ! -f packages/auso-phone/dist/auso-phone.js ]; then
  info "Building the phone bundle"
  (cd packages/auso-phone && npm install --silent && npm run build)
fi

# mkcert -install needs a password, so it cannot run unattended. Warn loudly:
# without a trusted CA the browser silently refuses the wss:// connection and
# registration never completes.
if ! mkcert -CAROOT >/dev/null 2>&1 || ! security find-certificate -c "mkcert" \
     /Library/Keychains/System.keychain >/dev/null 2>&1; then
  cat <<'EOF'

  ┌──────────────────────────────────────────────────────────────────────┐
  │  The local certificate authority is not trusted by your browser yet. │
  │  Chrome will refuse the secure WebSocket and the phone will never    │
  │  register. Run this once (it will ask for your password):            │
  │                                                                      │
  │      mkcert -install                                                 │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

EOF
fi

# ---- Asterisk --------------------------------------------------------------

info "Starting Asterisk"
docker compose -f asterisk/docker-compose.yml up -d --build

info "Waiting for Asterisk to become healthy"
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' auso-asterisk 2>/dev/null || echo starting)
  [ "$status" = "healthy" ] && break
  sleep 2
done
[ "${status:-}" = "healthy" ] || fail "Asterisk did not become healthy — check: docker compose -f asterisk/docker-compose.yml logs"

# ---- CRM server ------------------------------------------------------------

if lsof -ti tcp:8080 >/dev/null 2>&1; then
  info "Stopping the previous CRM server on port 8080"
  lsof -ti tcp:8080 | xargs kill 2>/dev/null || true
  sleep 1
fi

info "Starting the mock CRM on http://localhost:8080"
node server/index.mjs &
SERVER_PID=$!

trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM
wait $SERVER_PID
