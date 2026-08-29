# Auso Call Hub — WebRTC Phone

A reusable browser softphone for the Auso Call Hub call centre, built to the
requirements in `docs/spec.txt` (extracted from the original Word document).

SIP.js + WebRTC in the browser, Asterisk PJSIP over secure WebSocket for
signalling, and a Laravel-shaped backend that hands the phone short-lived SIP
credentials so the agent never types them.

Everything here runs on a Mac. The repository includes a dockerised Asterisk so
you can place real calls — with real DTLS-SRTP audio — without touching your
production PBX.

---

## Quick start

```bash
brew install node mkcert          # if you don't have them
mkcert -install                   # asks for your password — see the note below
./scripts/start.sh
```

Then open **http://localhost:8080** and sign in as `agent2@ausoworld.com`
(password `secret`). The phone registers itself; you should see a green
**registered** indicator within a second or two.

To make a real call, open a second browser window in **incognito** (a normal
second tab shares the session cookie and would sign you out of the first) and
sign in as `agent1@ausoworld.com`. Dial `2002` from one and answer on the other.

Stop everything with `./scripts/stop.sh`.

> **`mkcert -install` is not optional.** Asterisk serves the WebSocket over TLS,
> and Chrome refuses an untrusted certificate on a `wss://` connection *silently*
> — the page gets no error it can show you, and the phone simply never
> registers. `mkcert -install` adds the local CA to your system keychain so the
> certificate in `asterisk/certs/` is trusted. It needs your password, which is
> why `start.sh` cannot do it for you.

### Troubleshooting

**`WebSocket closed wss://localhost:8089/ws (code: 1006)`**
The browser doesn't trust the PBX certificate. Run `mkcert -install`, then fully
quit Chrome (⌘Q) and reopen. Code 1006 is an abnormal close with no close frame
— the WebSocket API deliberately hides handshake failure details from the page,
so this is what a rejected certificate always looks like.

**`Media devices not available in insecure contexts`**
You are not on a secure origin. Use **http://localhost:8080** — not the LAN IP,
and not `http://0.0.0.0:8080`. Browsers grant microphone access only on https,
`localhost`, `127.0.0.1` and `[::1]`; everything else has no
`navigator.mediaDevices` at all. To reach the console from another machine you
must terminate TLS in front of it.

**Registered, but no audio**
Check that the RTP range is published: `docker compose -f
asterisk/docker-compose.yml ps` should show `10000-10020/udp`. Dial `600` — if
you hear the echo prompt, media is fine.

### Try these

| Dial | What happens |
|---|---|
| `600` | Echo test — proves two-way audio |
| `601` | Music on hold — proves inbound audio |
| `602` | Reads your DTMF digits back |
| `2001`–`2005` | Another agent (needs a second signed-in window) |
| `90772615908` | Simulated outbound call to a customer |

The **Simulate inbound call** button originates a call to your extension over
AMI with the CLI `0772615908`, which exercises the whole screen-pop chain:
Asterisk → INVITE → phone → `incoming` event → CLI → CRM lookup → customer card.

---

## What's in the box

```
packages/auso-phone/     The phone. Framework-agnostic, no Laravel dependency.
  src/                     AusoPhone, SIPClient, CallManager, RegistrationManager,
                           MediaManager, TransferManager, EventManager, RecordingManager
  ui/                      <auso-phone> web component
  ui/vue/                  Vue 3 SFCs + usePhone() composable
  dist/                    Built bundles (IIFE for Blade, ESM for Vite)
  types/                   TypeScript definitions

asterisk/                Dockerised Asterisk 20 (PJSIP, WSS, DTLS-SRTP, MixMonitor)
server/                  Mock Laravel CRM — runs the whole flow with no PHP
laravel/                 Drop-in files for the real Laravel app
tests/e2e.mjs            End-to-end test: two headless Chromes, real calls
docs/spec.txt            The original requirements
```

---

## The phone API

Exactly the interface from spec §12. Available as `window.AusoPhone`, as an ES
module, or as `<auso-phone>`.

```js
AusoPhone.init({ credentialsUrl: '/api/phone/credentials' });
await AusoPhone.login({ extension: '2002' });   // fetch creds → WSS → REGISTER

AusoPhone.call('0772615908');
AusoPhone.answer();
AusoPhone.reject();
AusoPhone.hangup();
AusoPhone.hold();       AusoPhone.unhold();
AusoPhone.mute();       AusoPhone.unmute();
AusoPhone.transfer('2005');                        // blind
AusoPhone.transfer('2005', { type: 'attended' });  // consult first
AusoPhone.completeTransfer();
AusoPhone.sendDTMF('1');
AusoPhone.setAutoAnswer(true);
```

Events — every one from spec §3:

```js
AusoPhone.on('incoming', ({ call }) => {
  console.log(call.cli);        // "0772615908"  → look the customer up
});
```

`connecting` · `connected` · `disconnected` · `registered` · `unregistered` ·
`registration_failed` · `incoming` · `dialing` · `ringing` · `answered` ·
`hangup` · `hold` · `unhold` · `mute` · `unmute` · `transfer_started` ·
`transfer_completed` · `transfer_failed` · `dtmf` · `recording_started` ·
`recording_stopped` · `call_updated` · `error`

Every event is also dispatched on `window` as `ausophone:<event>`, which is how
the Livewire bridge in `laravel/` picks them up. Use `on('*', …)` to trace
everything.

### Using it

```html
<!-- Blade / Livewire — no build step -->
<script src="/js/auso-phone.min.js"></script>
<auso-phone credentials-url="/api/phone/credentials" auto-login></auso-phone>
```

```js
// Vue 3
import { AusoPhonePlugin, Phone } from 'auso-phone/vue';
app.use(AusoPhonePlugin, { credentialsUrl: '/api/phone/credentials' });
```

---

## Verifying it works

```bash
node tests/e2e.mjs
```

Launches three headless Chrome instances as separate agents and drives the real
stack — no mocks, no stubs. It asserts on live `RTCPeerConnection` statistics,
so "audio works" means bytes actually crossed the wire.

```
47/47 checks passed
```

Covers: automatic registration · credential rotation and reuse · outbound call
with DTLS-SRTP verified via getStats · DTMF · agent-to-agent call · CLI
delivery · hold/unhold re-INVITE · mute (and that the agent still *hears* the
far end while muted) · auto-answer · customer screen-pop by CLI · server-side
MixMonitor recording · blind transfer · full attended transfer with consultation
and bridged audio.

---

## Notes from the build

A few things worth knowing, because they cost real time to find:

**Asterisk is no longer in Debian.** It was dropped from bookworm and trixie.
The image is built on Ubuntu 24.04, which still ships 20.6 in universe.

**Container hostnames break strict SIP parsers.** Docker names a container with
its hex ID, which usually starts with a digit. Asterisk then puts
`sip:2001@3e76ca7421a2` in the `From` header of every inbound INVITE. RFC 3261
requires a hostname label to begin with a letter, so SIP.js rejects the message
and the agent never sees the call — with no visible error beyond a parser
warning. Fixed by `from_domain=localhost` on the endpoints plus an explicit
`hostname:` in compose.

**Don't rotate the SIP credential on every request.** It reads as the more
secure choice and it isn't: an agent with two tabs open, or the phone's own
pre-expiry refresh, will each invalidate the other and ping-pong forever. The
credential is made safe by being time-bounded, so reuse it until it expires.

**Blind and attended transfer need opposite cleanup.** After a blind transfer
the PBX still has to originate a new call and build a bridge, so hanging up the
transferring agent's leg on the `202 Accepted` can collapse the bridge and drop
the transferred customer. The phone waits for the RFC 3515 `NOTIFY` instead,
with a timed fallback. An attended transfer is the opposite: `REFER` with
`Replaces` swaps the dialogs atomically, so both legs can be dropped
immediately — and should be, because the agent expects to be free the moment
they press Complete.

**Media ports and Docker.** RTP is published as a small range (10000–10020)
because Docker Desktop publishes large UDP ranges very slowly. Asterisk
advertises `127.0.0.1` in SDP via `external_media_address`, since its container
address is unreachable from the browser.

---

## Pointing at your real PBX

```bash
SIP_DOMAIN=pbx.ausoworld.com \
SIP_WS_URL=wss://pbx.ausoworld.com:8089/ws \
SIP_ROTATE=0 \
node server/index.mjs
```

`SIP_ROTATE=0` hands out the static passwords from
`asterisk/dynamic/pjsip_auth.conf` instead of provisioning new ones, which is
what you want against a PBX this project doesn't manage. Put your real
extensions and passwords in that file.

For production, see `laravel/README.md` — the recommended setup provisions
per-session credentials into PJSIP realtime (`ps_auths`), so no reload is needed.

---

## Not implemented

Deliberately out of scope, matching the spec's own "Future" rows: video calls,
and QUIC/WebTransport. The spec is explicit that the first production version
should be SIP.js + WebRTC + Asterisk PJSIP/WSS, and that `chan_websocket` is not
a replacement for it.
