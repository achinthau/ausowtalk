#!/usr/bin/env bash
#
# Start the mock CRM against a PUBLIC (remote) Asterisk server — no Docker.
#
# Reads config from environment variables (with sensible defaults for the
# connectxp.ausoworld.com dev PBX):
#
#   SIP_DOMAIN      SIP realm/domain                        (default: connectxp.ausoworld.com)
#   SIP_WS_URL      secure WebSocket signalling endpoint    (default: wss://connectxp.ausoworld.com/ws)
#   SIP_EXTENSIONS  comma-separated extensions provisioned  (default: 2002)
#   PORT            HTTP port for the console               (default: 8080)
#
# Agent passwords come from asterisk/dynamic/pjsip_auth.conf (static, no rotation).
# Edit that file to match the passwords on your PBX, or point SIP_AUTH_FILE at it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null || { echo "ERROR: node is not installed" >&2; exit 1; }
[ -f packages/auso-phone/dist/auso-phone.js ] || { echo "ERROR: build the phone first: npm run build" >&2; exit 1; }

export SIP_DOMAIN="${SIP_DOMAIN:-connectxp.ausoworld.com}"
export SIP_WS_URL="${SIP_WS_URL:-wss://connectxp.ausoworld.com/ws}"
export SIP_EXTENSIONS="${SIP_EXTENSIONS:-2001,2002,2003,2004,2005,}"
export SIP_ROTATE="${SIP_ROTATE:-0}"
export PORT="${PORT:-8080}"

if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "Port $PORT is busy — stopping the previous server"
  lsof -ti tcp:"$PORT" | xargs kill 2>/dev/null || true
  sleep 1
fi

echo "Starting mock CRM on http://localhost:$PORT"
echo "  SIP WSS  $SIP_WS_URL"
echo "  Domain   $SIP_DOMAIN"
echo "  Exts     $SIP_EXTENSIONS (static passwords, no rotation)"
echo
exec node server/index.mjs
