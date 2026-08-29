# Laravel integration

Drop-in files for wiring `auso-phone` into the real Auso Call Hub CRM. Every
endpoint here has a working counterpart in `../server/index.mjs`, so you can
compare behaviour against a stack you can actually run.

## Files

| File | Purpose |
|---|---|
| `config/ausophone.php` | PBX address, credential strategy, branding, recording |
| `app/Services/SipCredentialProvisioner.php` | Issues short-lived SIP passwords (spec §2) |
| `app/Http/Controllers/Api/PhoneCredentialController.php` | `GET /api/phone/credentials` |
| `app/Http/Controllers/Api/PhoneCallController.php` | Customer lookup, call records, recordings, Asterisk CDR |
| `app/Models/CallRecord.php`, `app/Models/Customer.php` | Eloquent models |
| `database/migrations/2026_08_25_000001_create_auso_phone_tables.php` | Schema from spec §10 |
| `app/Livewire/AgentConsole.php` | Livewire component |
| `resources/views/livewire/agent-console.blade.php` | Blade view + the JS event bridge |
| `routes/api-snippet.php` | Routes to paste into `routes/api.php` |

## Install

```bash
# 1. Copy the files into your app, then:
php artisan migrate

# 2. Publish the phone bundle
cp ../packages/auso-phone/dist/auso-phone.min.js public/js/
```

Add to your layout, **before** the Livewire scripts:

```blade
<script src="{{ asset('js/auso-phone.min.js') }}"></script>
```

Then place the component:

```blade
<livewire:agent-console />
```

## Configuration

```dotenv
AUSOPHONE_SIP_DOMAIN=pbx.ausoworld.com
AUSOPHONE_WS_URL=wss://pbx.ausoworld.com:8089/ws
AUSOPHONE_CREDENTIAL_STRATEGY=rotate
AUSOPHONE_CREDENTIAL_TTL=3600
AUSOPHONE_CDR_TOKEN=change-me

# Only for strategy=rotate with PJSIP realtime
AUSOPHONE_REALTIME_CONNECTION=asterisk
```

Assign each agent an extension:

```php
User::find(1)->update(['extension' => '2002']);
```

## The two things that are easy to get wrong

**1. `wire:ignore` around the phone.** Livewire patches the DOM on every
round-trip. If the phone element is inside a patched region, Livewire will
replace it and tear down the live `RTCPeerConnection` — the call drops
mid-sentence. The Blade view wraps it in `wire:ignore` for this reason. Keep it.

**2. Don't forward `call_updated` into Livewire.** It fires once a second while
a call is up so the UI can tick the timer. Forwarding it means a server
round-trip every second per agent. Let the phone component render its own timer;
forward only the state-change events, as the supplied bridge does.

## Short-lived credentials (spec §2)

`SipCredentialProvisioner` mints a random 32-character password per agent
session rather than sending the permanent PJSIP password to the browser.

The recommended storage is **PJSIP realtime**: Asterisk reads `ps_auths` on
every authentication, so an `UPDATE` is live immediately with no reload.

```ini
; /etc/asterisk/sorcery.conf
[res_pjsip]
auth=realtime,ps_auths
```

```ini
; /etc/asterisk/extconfig.conf
ps_auths => odbc,asterisk
```

If realtime is not available, set `AUSOPHONE_AMI_ENABLED=true` and the service
falls back to rewriting an included auth file plus `pjsip reload`. That works,
but every reload re-reads the whole PJSIP configuration, so it does not scale to
a busy floor.

Note that re-fetching returns the *same* password until it expires. Rotating on
every request looks more secure but is not: an agent with two tabs open, or the
phone's own pre-expiry refresh, would each invalidate the other and the two
would fight indefinitely. Time-bounding is what makes the credential safe.

## Server-side recording

Recording is Asterisk's job (spec §10). Add `MixMonitor` to your dialplan and
push the result back on hangup — see `../asterisk/etc/extensions.conf` for a
working example, including the `curl` hangup handler that calls
`/api/asterisk/cdr`.

Browser recording (`MediaRecorder`) is available via
`AUSOPHONE_BROWSER_RECORDING=true`, but it dies with the tab, so keep it as a
supplement rather than the system of record.
