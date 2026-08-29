#!/bin/bash
# Copy the read-only mounted config into /etc/asterisk (Asterisk wants to be able
# to write there) and fail fast with a clear message if the TLS cert is missing.
set -euo pipefail

CONF_SRC=/etc/asterisk/conf.d
CERT_DIR=/etc/asterisk/keys

if [ -d "$CONF_SRC" ]; then
  cp -f "$CONF_SRC"/*.conf /etc/asterisk/ 2>/dev/null || true
fi

if [ ! -f "$CERT_DIR/asterisk.crt" ] || [ ! -f "$CERT_DIR/asterisk.key" ]; then
  cat <<'EOF' >&2
==============================================================================
 No TLS certificate found in asterisk/certs/.

 The browser will refuse a wss:// connection to an untrusted certificate, so
 generate a locally-trusted one first:

     ./scripts/make-certs.sh

 (that runs `mkcert -install` and writes asterisk.crt / asterisk.key)
==============================================================================
EOF
  exit 1
fi

chown -R asterisk:asterisk /var/spool/asterisk/recordings 2>/dev/null || true

if ! su asterisk -s /bin/bash -c "test -r $CERT_DIR/asterisk.key"; then
  echo "ERROR: $CERT_DIR/asterisk.key is not readable by the asterisk user." >&2
  echo "Run: chmod 644 asterisk/certs/asterisk.key" >&2
  exit 1
fi

exec asterisk -f -vvv -U asterisk -G asterisk
