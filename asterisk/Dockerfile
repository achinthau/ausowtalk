# Asterisk 20 with PJSIP + WebSocket (WSS) + DTLS-SRTP.
#
# Base is Ubuntu 24.04 rather than Debian: Asterisk was dropped from Debian
# bookworm/trixie, while Ubuntu noble still ships 20.6 in universe. Multi-arch,
# so this builds on both Apple Silicon and amd64 without a source compile.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      asterisk \
      asterisk-core-sounds-en-gsm \
      asterisk-moh-opsound-gsm \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/* \
 # Fail the build now, not at runtime, if the WebRTC modules are absent.
 # Ubuntu installs them under a multiarch path (/usr/lib/<triplet>/asterisk/modules).
 && for m in res_pjsip.so res_http_websocket.so res_srtp.so res_rtp_asterisk.so res_pjsip_refer.so; do \
      find /usr/lib -name "$m" -print -quit | grep -q . \
        || { echo "MISSING ASTERISK MODULE: $m" >&2; exit 1; }; \
    done \
 # We mount our own config over these; remove the distro samples so a typo in
 # our files fails loudly instead of silently falling back to the sample.
 && rm -f /etc/asterisk/pjsip.conf /etc/asterisk/extensions.conf /etc/asterisk/http.conf \
          /etc/asterisk/rtp.conf /etc/asterisk/manager.conf /etc/asterisk/logger.conf

RUN mkdir -p /var/spool/asterisk/recordings /etc/asterisk/keys /etc/asterisk/dynamic \
 && chown -R asterisk:asterisk /var/spool/asterisk /etc/asterisk/keys

EXPOSE 8088/tcp 8089/tcp 5038/tcp 10000-10020/udp

CMD ["asterisk", "-f", "-vvv", "-U", "asterisk", "-G", "asterisk"]
