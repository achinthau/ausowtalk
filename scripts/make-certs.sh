#!/usr/bin/env bash
#
# Generate a locally-trusted TLS certificate for Asterisk's WSS listener.
#
# A self-signed certificate is not enough: Chrome silently refuses a wss://
# connection to an untrusted certificate with no way for the page to prompt the
# user. mkcert installs a local CA into the system and browser trust stores, so
# wss://localhost:8089 just works.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT/asterisk/certs"

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert is not installed. Install it with:" >&2
  echo "    brew install mkcert nss" >&2
  exit 1
fi

mkdir -p "$CERT_DIR"

echo "==> Installing the local CA (may prompt for your password once)"
mkcert -install

echo "==> Issuing a certificate for localhost / 127.0.0.1"
mkcert -cert-file "$CERT_DIR/asterisk.crt" \
       -key-file  "$CERT_DIR/asterisk.key" \
       localhost 127.0.0.1 ::1 host.docker.internal

# Asterisk runs as the unprivileged `asterisk` user inside the container, which
# does not share our host UID — the key has to be world-readable. Acceptable for
# a development certificate that never leaves this machine.
chmod 644 "$CERT_DIR/asterisk.key" "$CERT_DIR/asterisk.crt"

echo
echo "Wrote:"
echo "  $CERT_DIR/asterisk.crt"
echo "  $CERT_DIR/asterisk.key"
echo
echo "Local CA root: $(mkcert -CAROOT)"
