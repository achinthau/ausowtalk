/**
 * Agent console — the "Laravel CRM" side of the demo.
 *
 * Note what this file does *not* do: it never touches SIP.js, WebRTC, or media.
 * It only calls the `AusoPhone` command API and reacts to the events from spec
 * §3. That separation is the point of spec §14 — a Livewire component would look
 * almost identical.
 */
const phone = window.AusoPhone;

const el = (id) => document.getElementById(id);
const ui = {
  loginScreen: el('login-screen'),
  loginForm: el('login-form'),
  loginBtn: el('login-btn'),
  loginError: el('login-error'),
  console: el('console'),
  agentName: el('agent-name'),
  agentExt: el('agent-ext'),
  regChip: el('reg-chip'),
  logoutBtn: el('logout-btn'),
  phoneEl: el('phone'),
  screenPop: el('screen-pop'),
  callsBody: document.querySelector('#calls-table tbody'),
  eventLog: el('event-log'),
  clearEvents: el('clear-events'),
  simInbound: el('sim-inbound'),
  amiState: el('ami-state'),
  sipDomain: el('sip-domain'),
  wsUrl: el('ws-url'),
  rotation: el('rotation'),
  pbxRefresh: el('pbx-refresh'),
  pbxDump: el('pbx-dump'),
};

let currentAgent = null;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

ui.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  ui.loginError.hidden = true;
  ui.loginBtn.disabled = true;
  ui.loginBtn.textContent = 'Signing in…';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: ui.loginForm.email.value,
        password: ui.loginForm.password.value,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message ?? 'Sign-in failed');
    await enterConsole(body.agent);
  } catch (err) {
    ui.loginError.textContent = err.message;
    ui.loginError.hidden = false;
  } finally {
    ui.loginBtn.disabled = false;
    ui.loginBtn.textContent = 'Sign in';
  }
});

ui.logoutBtn.addEventListener('click', async () => {
  // Spec §13: unregister first, then close the CRM session.
  await phone.logout().catch(() => {});
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

/**
 * Spec §13 — Agent Console Loaded → AusoPhone.initialize() → get SIP
 * credentials → connect WSS → REGISTER → registered → Agent Ready.
 */
async function enterConsole(agent) {
  currentAgent = agent;
  ui.loginScreen.hidden = true;
  ui.console.hidden = false;
  ui.agentName.textContent = agent.name;
  ui.agentExt.textContent = `ext ${agent.extension}`;

  const branding = await fetch('/api/branding').then((r) => r.json()).catch(() => ({}));

  // Everything the phone needs to talk to "Laravel".
  phone.init({
    credentialsUrl: '/api/phone/credentials',
    lookupUrl: '/api/customers/lookup',
    callRecordUrl: '/api/phone/call-records',
    branding,
    autoAnswer: Boolean(agent.auto_answer),
    logLevel: 'info',
    traceSip: false,
    recording: {
      enabled: true,        // browser recording available as the optional path
      autoStart: false,
      autoUpload: true,
      uploadUrl: '/api/phone/recordings',
    },
  });

  await loadHealth();
  await loadRecentCalls();
  subscribeServerEvents();

  try {
    await ui.phoneEl.login({ extension: agent.extension });
  } catch (err) {
    logEvent({ event: 'error', at: new Date().toISOString(), message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Phone events → CRM reactions (spec §3, §5)
// ---------------------------------------------------------------------------

phone.on('*', logEvent);

phone.on('registered', () => setRegChip('registered', 'registered'));
phone.on('registration_failed', () => setRegChip('failed', 'reg failed'));
phone.on('unregistered', () => setRegChip('', 'unregistered'));
phone.on('connecting', () => setRegChip('connecting', 'connecting'));
phone.on('disconnected', () => setRegChip('failed', 'disconnected'));

// Screen-pop. The phone has already asked Laravel for the customer by the time
// `call_updated` fires with a customer attached; `incoming` gets us on screen
// immediately with just the CLI.
phone.on('incoming', ({ call }) => renderScreenPop(call));
phone.on('dialing', ({ call }) => renderScreenPop(call));
phone.on('answered', ({ call }) => renderScreenPop(call));
phone.on('call_updated', ({ call }) => { if (call) renderScreenPop(call); });

phone.on('hangup', () => {
  renderScreenPop(null);
  // Give the server a moment to store the record the phone just posted.
  setTimeout(loadRecentCalls, 600);
});

function setRegChip(cls, label) {
  ui.regChip.className = `chip ${cls}`;
  ui.regChip.textContent = label;
}

function renderScreenPop(call) {
  if (!call) {
    ui.screenPop.className = 'card screen-pop empty';
    ui.screenPop.innerHTML = '<p class="placeholder">No active call. The customer record appears here as soon as an <code>incoming</code> event arrives, looked up by CLI.</p>';
    return;
  }

  const c = call.customer;
  const known = c && c.found !== false;
  ui.screenPop.className = 'card screen-pop';
  ui.screenPop.innerHTML = `
    <div class="pop-head">
      <span class="pop-title">${known ? esc(c.name) : 'Unknown caller'}</span>
      <span class="pop-dir ${call.direction}">${call.direction}</span>
      <span class="pop-num">${esc(call.cli)}</span>
    </div>
    <dl>
      ${known && c.company ? row('Company', c.company) : ''}
      ${known && c.account_number ? row('Account', c.account_number) : ''}
      ${known && c.email ? row('Email', c.email) : ''}
      ${known && c.city ? row('City', c.city) : ''}
      ${known && c.previous_calls != null ? row('Previous calls', c.previous_calls) : ''}
      ${known && c.last_call ? row('Last call', c.last_call) : ''}
      ${known && c.notes ? row('Notes', c.notes) : ''}
      ${row('Call state', call.state)}
      ${row('Call ID', `<span class="mono small">${esc(call.call_id)}</span>`)}
      ${!known ? row('Lookup', '<span class="unknown">No customer matched this CLI</span>') : ''}
    </dl>`;
}

const row = (k, v) => `<dt>${esc(k)}</dt><dd>${typeof v === 'string' && v.startsWith('<') ? v : esc(v)}</dd>`;

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

function logEvent(e) {
  const detail = e.call
    ? `${e.call.direction} ${e.call.cli} [${e.call.state}]`
    : Object.entries(e)
        .filter(([k]) => !['event', 'at', 'calls'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ')
        .slice(0, 120);

  const div = document.createElement('div');
  div.className = 'row';
  div.innerHTML = `<span class="t">${new Date(e.at ?? Date.now()).toLocaleTimeString('en-GB')}</span>`
    + `<span class="n ${esc(e.event)}">${esc(e.event)}</span>`
    + `<span class="d">${esc(detail)}</span>`;
  ui.eventLog.prepend(div);

  // `call_updated` fires once a second while a call is up; don't let it grow
  // without bound.
  while (ui.eventLog.childElementCount > 300) ui.eventLog.lastElementChild.remove();
}

ui.clearEvents.addEventListener('click', () => { ui.eventLog.innerHTML = ''; });

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

document.querySelectorAll('[data-dial]').forEach((btn) => {
  btn.addEventListener('click', () => {
    phone.call(btn.dataset.dial).catch((err) => {
      logEvent({ event: 'error', at: new Date().toISOString(), message: err.message });
    });
  });
});

ui.simInbound.addEventListener('click', async () => {
  ui.simInbound.disabled = true;
  ui.simInbound.textContent = 'Ringing your phone…';
  try {
    const res = await fetch('/api/simulate/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli: '0772615908' }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message);
  } catch (err) {
    logEvent({ event: 'error', at: new Date().toISOString(), message: `simulate: ${err.message}` });
  } finally {
    setTimeout(() => {
      ui.simInbound.disabled = false;
      ui.simInbound.textContent = 'Simulate inbound call from 0772615908';
    }, 2500);
  }
});

// ---------------------------------------------------------------------------
// Server data
// ---------------------------------------------------------------------------

async function loadHealth() {
  const h = await fetch('/api/health').then((r) => r.json()).catch(() => null);
  if (!h) return;
  ui.amiState.textContent = h.ami ? 'connected' : 'not connected';
  ui.amiState.style.color = h.ami ? 'var(--success)' : 'var(--danger)';
  ui.sipDomain.textContent = h.sip_domain;
  ui.wsUrl.textContent = h.ws_url;
  ui.rotation.textContent = h.rotate_credentials ? 'per-session password' : 'static password';
}

async function loadRecentCalls() {
  const body = await fetch('/api/calls/recent?limit=15').then((r) => r.json()).catch(() => null);
  const rows = body?.records ?? [];
  if (!rows.length) {
    ui.callsBody.innerHTML = '<tr class="empty-row"><td colspan="6">No calls yet</td></tr>';
    return;
  }
  ui.callsBody.innerHTML = rows.map((r) => {
    const rec = r.recording_path
      ? `<audio controls preload="none" src="/${r.recording_path}"></audio>`
      : (r.browser_recording_path ? `<audio controls preload="none" src="/${r.browser_recording_path}"></audio>` : '—');
    return `<tr>
      <td class="num">${esc(shortTime(r.start_time))}</td>
      <td><span class="dir">${esc((r.direction ?? '?').slice(0, 3).toUpperCase())}</span></td>
      <td class="num">${esc(r.customer_number ?? '—')}</td>
      <td class="num">${esc(r.extension ?? '—')}</td>
      <td class="num">${esc(formatDur(r.billsec ?? r.duration ?? 0))}</td>
      <td>${rec}</td>
    </tr>`;
  }).join('');
}

/** Live CDR / AMI feed so the table updates without polling. */
function subscribeServerEvents() {
  const stream = new EventSource('/api/events');
  stream.onmessage = (msg) => {
    const payload = JSON.parse(msg.data);
    if (payload.type === 'asterisk_cdr' || payload.type === 'call_record') {
      loadRecentCalls();
    } else if (payload.type === 'ami') {
      logEvent({
        event: 'ami',
        at: new Date().toISOString(),
        detail: `${payload.event} ${payload.endpoint ?? payload.channel ?? ''} ${payload.status ?? ''}`.trim(),
      });
    }
  };
  stream.onerror = () => { /* EventSource reconnects on its own */ };
}

ui.pbxRefresh.addEventListener('click', async () => {
  const body = await fetch('/api/pbx/status').then((r) => r.json());
  ui.pbxDump.hidden = false;
  ui.pbxDump.textContent = body.ami
    ? `${body.endpoints ?? ''}\n\n${body.contacts ?? ''}`.trim() || (body.error ?? 'no output')
    : 'AMI is not connected — is the Asterisk container running?';
});

// ---------------------------------------------------------------------------
// Boot: resume an existing CRM session on reload
// ---------------------------------------------------------------------------

fetch('/api/me')
  .then((r) => (r.ok ? r.json() : null))
  .then((body) => { if (body?.agent) return enterConsole(body.agent); })
  .catch(() => {});

// Unregister cleanly if the agent just closes the tab.
window.addEventListener('beforeunload', () => {
  if (phone.status().registered) phone.logout();
});

// ---------------------------------------------------------------------------

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shortTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function formatDur(s) {
  const n = Number(s) || 0;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
