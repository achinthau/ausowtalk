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

  // Ask up front (not on the first call) so the OS popup is ready for calls.
  if ('Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* ignore */ }
  }

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

// Web Notification (OS popup) on an inbound call. Fires even while the tab is
// in the background / the agent is on another tab, because 'incoming' is pushed
// on `window` regardless of focus.
function notifyIncoming(call) {
  if (!call || !('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission();
    return;
  }
  if (Notification.permission !== 'granted') return;

  const name = call.customer?.name;
  const title = `Incoming call — ${call.cli}`;
  try {
    const n = new Notification(name ? `${name} (${call.cli})` : title, {
      body: `Call from ${call.cli} · ${call.direction}`,
      icon: '/assets/logo.svg',
      tag: `incoming-${call.call_id}`,
      requireInteraction: true,
    });
    // Clicking the notification focuses the window, revealing the in-page
    // centred phone window (which has Answer / Hang up buttons).
    n.onclick = () => { window.focus(); showCallWindow(call); n.close(); };
    // Keep the popup visible for 15s (set to 0 to keep it until dismissed).
    setTimeout(() => n.close(), 15000);
  } catch {
    /* notifications can be transiently blocked in some contexts */
  }
}

// ---------------------------------------------------------------------------
// Incoming-call window — phone-sized, centred, draggable, minimisable.
// Single SIP registration lives here in the console; this window controls it.
// ---------------------------------------------------------------------------

const cw = {
  root: document.getElementById('call-window'),
  titlebar: document.querySelector('.cw-titlebar'),
  titleText: document.getElementById('cw-title-text'),
  minimize: document.getElementById('cw-minimize'),
  close: document.getElementById('cw-close'),
  avatar: document.getElementById('cw-avatar'),
  initial: document.getElementById('cw-initial'),
  name: document.getElementById('cw-name'),
  cli: document.getElementById('cw-cli'),
  state: document.getElementById('cw-state'),
  ext: document.getElementById('cw-ext'),
  hold: document.getElementById('cw-hold'),
  mute: document.getElementById('cw-mute'),
  answer: document.getElementById('cw-answer'),
  hangup: document.getElementById('cw-hangup'),
  minimized: document.getElementById('cw-minimized'),
  minimizedLabel: document.getElementById('cw-minimized-label'),
};

let activeCallId = null;
let muted = false;
let onHold = false;

function showCallWindow(call) {
  if (!call || !cw.root) return;
  activeCallId = call.call_id ?? null;
  muted = false;
  onHold = false;

  const customer = call.customer;
  const known = customer && customer.found !== false;
  const name = known && customer.name ? customer.name : 'Unknown caller';
  cw.name.textContent = name;
  cw.cli.textContent = call.cli ?? '—';
  cw.initial.textContent = (name[0] || '?').toUpperCase();
  cw.state.textContent = 'Ringing…';
  cw.ext.textContent = currentAgent ? `Auso Call Hub · ext ${currentAgent.extension}` : '';

  cw.answer.disabled = false;
  cw.hangup.disabled = true;
  cw.hold.disabled = false;
  cw.mute.disabled = false;
  cw.titleText.textContent = 'Incoming call';

  // Reset any earlier minimise state.
  cw.root.hidden = false;
  cw.minimized.hidden = true;
  resetWindowPosition();

  restorePadLabels();
  updateMinimizedLabel(name);
}

function hideCallWindow() {
  if (!cw.root) return;
  cw.root.hidden = true;
  cw.minimized.hidden = true;
  activeCallId = null;
}

function minimizeCallWindow() {
  if (!cw.root) return;
  cw.root.hidden = true;
  cw.minimized.hidden = false;
}

function restoreCallWindow() {
  if (!cw.root) return;
  cw.minimized.hidden = true;
  cw.root.hidden = false;
  resetWindowPosition();
}

function updateMinimizedLabel(label) {
  if (cw.minimizedLabel) cw.minimizedLabel.textContent = label;
}

function restorePadLabels() {
  cw.hold.innerHTML = '<span class="cw-padicon">⏸</span><span class="cw-padlabel">Hold</span>';
  cw.mute.innerHTML = '<span class="cw-padicon">🎙</span><span class="cw-padlabel">Mute</span>';
}

// ---- Dragging -------------------------------------------------------------

function resetWindowPosition() {
  // Back to centre.
  cw.root.style.left = '50%';
  cw.root.style.top = '50%';
  cw.root.style.transform = 'translate(-50%, -50%)';
  cw.root.style.margin = '0';
}

let drag = null;

function startDrag(e) {
  // Only when NOT minimised.
  if (cw.root.hidden) return;
  if (e.target.closest('.cw-btn')) return; // let buttons work
  const rect = cw.root.getBoundingClientRect();
  drag = {
    startX: e.clientX, startY: e.clientY,
    offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
  };
  cw.root.style.transition = 'none';
  cw.root.style.left = `${rect.left}px`;
  cw.root.style.top = `${rect.top}px`;
  cw.root.style.transform = 'none';
  cw.root.style.margin = '0';
  e.preventDefault();
}

function onDragMove(e) {
  if (!drag) return;
  cw.root.style.left = `${e.clientX - drag.offsetX}px`;
  cw.root.style.top = `${e.clientY - drag.offsetY}px`;
}

function endDrag() {
  drag = null;
  cw.root.style.transition = '';
}

cw.titlebar.addEventListener('mousedown', startDrag);
window.addEventListener('mousemove', onDragMove);
window.addEventListener('mouseup', endDrag);

// ---- Buttons --------------------------------------------------------------

cw.minimize.addEventListener('click', minimizeCallWindow);
cw.close.addEventListener('click', hideCallWindow);
cw.minimized.addEventListener('click', restoreCallWindow);

cw.answer.addEventListener('click', () => {
  cw.answer.disabled = true;
  cw.answer.innerHTML = '<span class="cw-padicon">☎</span><span class="cw-padlabel">Answering…</span>';
  phone.answer(activeCallId).catch((err) => {
    logEvent({ event: 'error', at: new Date().toISOString(), message: `answer: ${err.message}` });
    cw.answer.disabled = false;
    cw.answer.innerHTML = '<span class="cw-padicon">☎</span><span class="cw-padlabel">Answer</span>';
  });
});

cw.hangup.addEventListener('click', () => {
  cw.hangup.disabled = true;
  phone.hangup(activeCallId).catch(() => {});
});

cw.hold.addEventListener('click', async () => {
  onHold = !onHold;
  try {
    if (onHold) await phone.hold(activeCallId);
    else await phone.unhold(activeCallId);
    cw.hold.innerHTML = `<span class="cw-padicon">${onHold ? '▶' : '⏸'}</span><span class="cw-padlabel">${onHold ? 'Resume' : 'Hold'}</span>`;
  } catch (err) {
    onHold = !onHold;
    logEvent({ event: 'error', at: new Date().toISOString(), message: `hold: ${err.message}` });
  }
});

cw.mute.addEventListener('click', async () => {
  muted = !muted;
  try {
    if (muted) await phone.mute(activeCallId);
    else await phone.unmute(activeCallId);
    cw.mute.innerHTML = `<span class="cw-padicon">${muted ? '🔇' : '🎙'}</span><span class="cw-padlabel">${muted ? 'Unmute' : 'Mute'}</span>`;
  } catch (err) {
    muted = !muted;
    logEvent({ event: 'error', at: new Date().toISOString(), message: `mute: ${err.message}` });
  }
});

phone.on('incoming', ({ call }) => {
  renderScreenPop(call);
  showCallWindow(call);
  notifyIncoming(call);
});

phone.on('registered', () => setRegChip('registered', 'registered'));
phone.on('registration_failed', () => setRegChip('failed', 'reg failed'));
phone.on('unregistered', () => setRegChip('', 'unregistered'));
phone.on('connecting', () => setRegChip('connecting', 'connecting'));
phone.on('disconnected', () => setRegChip('failed', 'disconnected'));

// Screen-pop. The phone has already asked Laravel for the customer by the time
// `call_updated` fires with a customer attached; `incoming` gets us on screen
// immediately with just the CLI.
phone.on('dialing', ({ call }) => renderScreenPop(call));
phone.on('answered', ({ call }) => {
  renderScreenPop(call);
  if (cw.root && !cw.root.hidden) {
    cw.state.textContent = 'On call';
    cw.answer.disabled = true;
    cw.hangup.disabled = false;
    cw.titleText.textContent = 'On call';
  }
});
phone.on('call_updated', ({ call }) => {
  if (call) renderScreenPop(call);
  if (call && call.state) cw.state.textContent = call.state;
});

phone.on('hangup', () => {
  renderScreenPop(null);
  hideCallWindow();
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
