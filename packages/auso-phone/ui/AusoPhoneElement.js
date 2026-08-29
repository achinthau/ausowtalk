import { phone as defaultPhone } from '../src/AusoPhone.js';
import { CallState, Direction, PhoneEvents, RegistrationState } from '../src/events.js';
import { styles } from './styles.js';
import { icons } from './icons.js';

const KEYS = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

/**
 * `<auso-phone>` — the drop-in agent softphone.
 *
 * Renders the DialPad / IncomingCall / ActiveCall / TransferDialog views from
 * spec §14 inside a shadow root, so it can be pasted into any Blade or Livewire
 * page without touching the host app's CSS.
 *
 *   <auso-phone credentials-url="/api/phone/credentials" auto-login></auso-phone>
 */
export class AusoPhoneElement extends HTMLElement {
  static get observedAttributes() {
    return ['theme', 'primary-color', 'logo', 'company-name', 'extension'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    /** Swap in a different AusoPhone instance before connectedCallback for tests. */
    this.phone = defaultPhone;
    this.view = 'dialpad'; // dialpad | transfer | settings
    this.dialValue = '';
    this.transferTarget = '';
    this.transferType = 'blind';
    this.errorMessage = '';
    this.devices = { inputs: [], outputs: [] };
    this._unsubscribers = [];
    this._rendered = false;
  }

  connectedCallback() {
    if (!this._rendered) {
      this.shadowRoot.innerHTML = `<style>${styles}</style><div class="phone"></div>`;
      this._root = this.shadowRoot.querySelector('.phone');
      this._rendered = true;
    }

    this._applyBrandingAttributes();
    this._subscribe();
    this.render();

    if (this.hasAttribute('auto-login')) {
      // Defer so the host page can attach listeners first.
      queueMicrotask(() => this.login().catch(() => {}));
    }
  }

  disconnectedCallback() {
    this._unsubscribers.forEach((off) => off());
    this._unsubscribers = [];
  }

  attributeChangedCallback() {
    if (!this._rendered) return;
    this._applyBrandingAttributes();
    this.render();
  }

  // ---- Public API (so the host page can drive the widget) ----------------

  /** Configure the underlying phone from element attributes + an options bag. */
  configure(options = {}) {
    this.phone.init({
      credentialsUrl: this.getAttribute('credentials-url') ?? undefined,
      lookupUrl: this.getAttribute('lookup-url') ?? undefined,
      callRecordUrl: this.getAttribute('call-record-url') ?? undefined,
      autoAnswer: this.hasAttribute('auto-answer'),
      traceSip: this.hasAttribute('trace-sip'),
      branding: this._brandingFromAttributes(),
      ...options,
    });
    return this;
  }

  async login(opts = {}) {
    this.errorMessage = '';
    this.render();
    try {
      this.configure(opts.config);
      const status = await this.phone.login(opts);
      this.devices = await this.phone.listDevices().catch(() => this.devices);
      this.render();
      return status;
    } catch (err) {
      this.errorMessage = err.message;
      this.render();
      throw err;
    }
  }

  logout() {
    return this.phone.logout().finally(() => this.render());
  }

  // ---- Rendering ---------------------------------------------------------

  _subscribe() {
    const rerender = () => this.render();
    // Every state-affecting event triggers a re-render. The component is small
    // enough that full innerHTML replacement is cheaper than diffing.
    const watched = [
      PhoneEvents.CONNECTING, PhoneEvents.CONNECTED, PhoneEvents.DISCONNECTED,
      PhoneEvents.REGISTERED, PhoneEvents.UNREGISTERED, PhoneEvents.REGISTRATION_FAILED,
      PhoneEvents.INCOMING, PhoneEvents.DIALING, PhoneEvents.RINGING, PhoneEvents.ANSWERED,
      PhoneEvents.HANGUP, PhoneEvents.HOLD, PhoneEvents.UNHOLD, PhoneEvents.MUTE,
      PhoneEvents.UNMUTE, PhoneEvents.CALL_UPDATED,
      PhoneEvents.TRANSFER_STARTED, PhoneEvents.TRANSFER_COMPLETED, PhoneEvents.TRANSFER_FAILED,
      PhoneEvents.RECORDING_STARTED, PhoneEvents.RECORDING_STOPPED,
    ];
    watched.forEach((e) => this._unsubscribers.push(this.phone.on(e, rerender)));

    this._unsubscribers.push(
      this.phone.on(PhoneEvents.ERROR, ({ message, fatal }) => {
        if (fatal !== false) this.errorMessage = message;
        this.render();
      }),
    );
    // Leaving the transfer view once a transfer resolves keeps the UI honest.
    this._unsubscribers.push(
      this.phone.on(PhoneEvents.TRANSFER_COMPLETED, () => {
        this.view = 'dialpad';
        this.transferTarget = '';
      }),
    );
  }

  render() {
    if (!this._root) return;
    const s = this.phone.status();
    const incoming = s.calls.find((c) => c.direction === Direction.INBOUND && c.state === CallState.RINGING);
    const active = s.calls.find((c) => c.state === CallState.ANSWERED || c.state === CallState.HELD)
      ?? s.calls.find((c) => c.state === CallState.DIALING || c.state === CallState.RINGING);

    // Preserve focus/caret across the innerHTML swap.
    const focusedId = this.shadowRoot.activeElement?.id;
    const caret = this.shadowRoot.activeElement?.selectionStart;

    this._root.innerHTML = [
      this._renderHeader(s),
      this._renderStatus(s),
      '<div class="body">',
      this.errorMessage ? `<div class="error">${esc(this.errorMessage)}</div>` : '',
      incoming ? this._renderIncoming(incoming) : '',
      !incoming && active ? this._renderActive(active, s) : '',
      !incoming && !active && this.view === 'dialpad' ? this._renderDialPad(s) : '',
      this.view === 'transfer' ? this._renderTransferDialog(s) : '',
      this.view === 'settings' ? this._renderSettings(s) : '',
      '</div>',
      s.branding.show_powered_by ? '<div class="footer">Powered by AusoPhone</div>' : '',
    ].join('');

    this._bindEvents();

    if (focusedId) {
      const el = this.shadowRoot.getElementById(focusedId);
      if (el) {
        el.focus();
        if (caret != null && el.setSelectionRange) el.setSelectionRange(caret, caret);
      }
    }
  }

  _renderHeader(s) {
    const b = s.branding;
    return `<div class="header">
      ${b.logo ? `<img src="${esc(b.logo)}" alt="${esc(b.company_name)}">` : ''}
      <div class="brand">${esc(b.company_name)}</div>
      ${s.extension ? `<span class="ext">Ext ${esc(s.extension)}</span>` : ''}
      <button class="icon-btn" data-action="toggle-settings" title="Settings" aria-label="Settings">${icons.settings}</button>
    </div>`;
  }

  _renderStatus(s) {
    const map = {
      [RegistrationState.REGISTERED]: ['registered', 'Registered'],
      [RegistrationState.REGISTERING]: ['connecting', 'Registering…'],
      [RegistrationState.FAILED]: ['failed', 'Registration failed'],
      [RegistrationState.UNREGISTERED]: ['', s.connection === 'connected' ? 'Connected' : 'Offline'],
    };
    const [cls, text] = map[s.registration] ?? ['', 'Offline'];
    return `<div class="status">
      <span class="dot ${cls}"></span><span>${esc(text)}</span>
      <span class="spacer"></span>
      ${s.auto_answer ? '<span class="pill">Auto answer</span>' : ''}
      ${!s.registered ? '<button class="icon-btn" data-action="login" title="Connect" style="color:var(--auso-muted)">' + icons.phone + '</button>' : ''}
    </div>`;
  }

  /** IncomingCall view — spec §5 screen-pop lives here. */
  _renderIncoming(call) {
    return `<div class="call-card incoming">
      <div class="label">Incoming call</div>
      <div class="cli">${esc(call.cli)}</div>
      <div class="who">${esc(call.remote_display_name || '')}</div>
      ${this._renderCustomer(call)}
      <div class="controls">
        <button class="btn btn-success" data-action="answer" data-call="${esc(call.call_id)}">${icons.phone}Answer</button>
        <button class="btn btn-danger" data-action="reject" data-call="${esc(call.call_id)}">${icons.x}Reject</button>
      </div>
    </div>`;
  }

  /** ActiveCall view — mirrors the mockup: timer, Mute, Hold, Transfer, Hangup. */
  _renderActive(call, s) {
    const label = {
      [CallState.DIALING]: 'Dialing',
      [CallState.RINGING]: call.direction === Direction.OUTBOUND ? 'Ringing' : 'Incoming',
      [CallState.ANSWERED]: 'Active call',
      [CallState.HELD]: 'On hold',
    }[call.state] ?? 'Call';
    const established = call.state === CallState.ANSWERED || call.state === CallState.HELD;
    const consulting = s.transfer?.stage && s.transfer.stage !== 'completed';

    return `<div class="call-card">
      <div class="label">${esc(label)}${call.consultation ? ' · consultation' : ''}</div>
      <div class="cli">${esc(call.cli)}</div>
      <div class="who">${esc(call.remote_display_name || '')}</div>
      <div class="timer">${formatDuration(call.duration)}</div>
      <div class="badges">
        ${call.held ? '<span class="badge hold">Hold</span>' : ''}
        ${call.muted ? '<span class="badge mute">Muted</span>' : ''}
        ${call.recording ? '<span class="badge rec">Rec</span>' : ''}
        ${consulting ? '<span class="badge auto">Transfer pending</span>' : ''}
      </div>
      ${this._renderCustomer(call)}
      <div class="controls controls-4">
        <button class="btn btn-ghost ${call.muted ? 'active' : ''}" data-action="toggle-mute" data-call="${esc(call.call_id)}" ${established ? '' : 'disabled'}>
          ${call.muted ? icons.micOff : icons.mic}${call.muted ? 'Unmute' : 'Mute'}
        </button>
        <button class="btn btn-ghost ${call.held ? 'active' : ''}" data-action="toggle-hold" data-call="${esc(call.call_id)}" ${established ? '' : 'disabled'}>
          ${call.held ? icons.play : icons.pause}${call.held ? 'Resume' : 'Hold'}
        </button>
        <button class="btn btn-ghost" data-action="open-transfer" ${established ? '' : 'disabled'}>
          ${icons.transfer}Transfer
        </button>
        <button class="btn btn-danger" data-action="hangup" data-call="${esc(call.call_id)}">
          ${icons.hangup}Hangup
        </button>
      </div>
      ${established ? `<div style="margin-top:8px" class="btn-row">
        <button class="btn btn-ghost" data-action="open-dtmf">${icons.keypad}Keypad</button>
        <button class="btn btn-ghost ${call.recording ? 'active' : ''}" data-action="toggle-record" data-call="${esc(call.call_id)}">
          ${call.recording ? icons.stop : icons.record}${call.recording ? 'Stop rec' : 'Record'}
        </button>
      </div>` : ''}
      ${consulting ? this._renderConsultControls(s) : ''}
    </div>`;
  }

  _renderConsultControls(s) {
    const ready = s.transfer.consultCallId
      && s.calls.find((c) => c.call_id === s.transfer.consultCallId)?.state === CallState.ANSWERED;
    return `<div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
      <button class="btn btn-ghost" data-action="swap-legs">${icons.swap}Swap</button>
      <button class="btn btn-success" data-action="complete-transfer" ${ready ? '' : 'disabled'}>${icons.check}Complete</button>
      <button class="btn btn-ghost" data-action="cancel-transfer">${icons.x}Cancel</button>
    </div>`;
  }

  _renderCustomer(call) {
    const c = call.customer;
    if (!c) return '';
    const bits = [
      c.phone ? esc(c.phone) : '',
      c.previous_calls != null ? `${c.previous_calls} previous calls` : '',
      c.last_call ? `last ${esc(c.last_call)}` : '',
    ].filter(Boolean);
    return `<div class="customer">
      <div class="name">${esc(c.name || c.company || 'Known customer')}</div>
      <div class="meta">${bits.join(' · ')}</div>
    </div>`;
  }

  /** DialPad view. */
  _renderDialPad(s) {
    const canDial = s.registered && this.dialValue.length > 0;
    return `<div class="dial-input">
      <input id="dial" type="tel" inputmode="tel" placeholder="Enter number" value="${esc(this.dialValue)}" aria-label="Number to dial">
      ${this.dialValue ? `<button class="icon-btn" data-action="backspace" aria-label="Backspace">${icons.backspace}</button>` : ''}
    </div>
    <div class="keys">
      ${KEYS.map(([d, l]) => `<button class="key" data-action="key" data-key="${d}">
        <span class="digit">${d}</span><span class="letters">${l}</span>
      </button>`).join('')}
    </div>
    <button class="btn btn-primary btn-block" data-action="dial" ${canDial ? '' : 'disabled'}>
      ${icons.phone}${s.registered ? 'Call' : 'Not registered'}
    </button>`;
  }

  /** TransferDialog — blind vs attended (spec §8). */
  _renderTransferDialog(s) {
    const attendedRunning = Boolean(s.transfer);
    return `<div class="panel">
      <h4>Transfer call</h4>
      ${attendedRunning ? '<div class="hint" style="margin-bottom:10px">An attended transfer is already in progress — use the call controls to complete or cancel it.</div>' : `
      <div class="seg">
        <button class="btn ${this.transferType === 'blind' ? 'btn-primary' : 'btn-ghost'}" data-action="transfer-type" data-type="blind">Blind</button>
        <button class="btn ${this.transferType === 'attended' ? 'btn-primary' : 'btn-ghost'}" data-action="transfer-type" data-type="attended">Attended</button>
      </div>
      <div class="field">
        <label for="transfer-target">Destination</label>
        <input id="transfer-target" type="tel" placeholder="e.g. 2005" value="${esc(this.transferTarget)}">
      </div>
      <div class="hint">${this.transferType === 'blind'
        ? 'Sends a REFER immediately and drops you from the call.'
        : 'Holds the customer and dials the destination so you can announce the call first.'}</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-ghost" data-action="close-panel">Cancel</button>
        <button class="btn btn-primary" data-action="do-transfer" ${this.transferTarget ? '' : 'disabled'}>
          ${icons.transfer}Transfer
        </button>
      </div>`}
      ${attendedRunning ? '<button class="btn btn-ghost btn-block" data-action="close-panel">Close</button>' : ''}
    </div>`;
  }

  _renderSettings(s) {
    const opt = (list, selected) => list.map((d) =>
      `<option value="${esc(d.deviceId)}" ${d.deviceId === selected ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
    return `<div class="panel">
      <h4>Settings</h4>
      <label class="toggle">
        <input type="checkbox" data-action="auto-answer" ${s.auto_answer ? 'checked' : ''}>
        <span>Auto answer incoming calls</span>
      </label>
      <div class="hint" style="margin-bottom:12px">When enabled the phone answers automatically as soon as Asterisk sends the INVITE.</div>
      <div class="field">
        <label for="mic">Microphone</label>
        <select id="mic" data-action="set-input">${opt(this.devices.inputs, this.phone.media.inputDeviceId)}</select>
      </div>
      <div class="field">
        <label for="spk">Speaker</label>
        <select id="spk" data-action="set-output">${opt(this.devices.outputs, this.phone.media.outputDeviceId)}</select>
      </div>
      <div class="btn-row">
        <button class="btn btn-ghost" data-action="close-panel">Close</button>
        ${s.registered
          ? '<button class="btn btn-danger" data-action="logout">Unregister</button>'
          : '<button class="btn btn-primary" data-action="login">Register</button>'}
      </div>
    </div>`;
  }

  // ---- Event binding -----------------------------------------------------

  _bindEvents() {
    const root = this.shadowRoot;

    root.querySelectorAll('[data-action]').forEach((el) => {
      const action = el.dataset.action;
      if (el.tagName === 'SELECT' || el.type === 'checkbox') {
        el.addEventListener('change', (e) => this._handle(action, el, e));
      } else {
        el.addEventListener('click', (e) => this._handle(action, el, e));
      }
    });

    const dial = root.getElementById('dial');
    if (dial) {
      dial.addEventListener('input', (e) => {
        this.dialValue = e.target.value;
        // Toggle the Call button without a full re-render so typing stays smooth.
        const btn = root.querySelector('[data-action="dial"]');
        if (btn) btn.disabled = !(this.phone.status().registered && this.dialValue.length);
      });
      dial.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._handle('dial');
      });
    }

    const target = root.getElementById('transfer-target');
    if (target) {
      target.addEventListener('input', (e) => {
        this.transferTarget = e.target.value;
        const btn = root.querySelector('[data-action="do-transfer"]');
        if (btn) btn.disabled = !this.transferTarget;
      });
      target.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && this.transferTarget) this._handle('do-transfer');
      });
    }
  }

  async _handle(action, el, event) {
    const callId = el?.dataset?.call;
    try {
      this.errorMessage = '';
      switch (action) {
        case 'key': {
          const key = el.dataset.key;
          const active = this.phone.getActiveCall();
          // On an established call the keypad sends DTMF instead of dialing.
          if (active && active.state === CallState.ANSWERED && this.view === 'dtmf') {
            await this.phone.sendDTMF(key);
          } else {
            this.dialValue += key;
            this.render();
          }
          return;
        }
        case 'backspace':
          this.dialValue = this.dialValue.slice(0, -1);
          this.render();
          return;
        case 'dial':
          if (!this.dialValue) return;
          await this.phone.call(this.dialValue);
          this.dialValue = '';
          return;
        case 'answer': return void (await this.phone.answer(callId));
        case 'reject': return void (await this.phone.reject(callId));
        case 'hangup': return void (await this.phone.hangup(callId));
        case 'toggle-mute': return void (await this.phone.toggleMute(callId));
        case 'toggle-hold': return void (await this.phone.toggleHold(callId));
        case 'open-transfer':
          this.view = 'transfer';
          return this.render();
        case 'open-dtmf':
          this.view = this.view === 'dtmf' ? 'dialpad' : 'dtmf';
          return this.render();
        case 'transfer-type':
          this.transferType = el.dataset.type;
          return this.render();
        case 'do-transfer': {
          const to = this.transferTarget;
          await this.phone.transfer(to, { type: this.transferType });
          if (this.transferType === 'blind') this.transferTarget = '';
          this.view = 'dialpad';
          return this.render();
        }
        case 'complete-transfer': return void (await this.phone.completeTransfer());
        case 'cancel-transfer': return void (await this.phone.cancelTransfer());
        case 'swap-legs': return void (await this.phone.swapTransferLegs());
        case 'toggle-record': {
          const call = this.phone.getActiveCall();
          if (call?.recording) await this.phone.stopRecording(callId);
          else this.phone.startRecording(callId);
          return this.render();
        }
        case 'toggle-settings':
          this.view = this.view === 'settings' ? 'dialpad' : 'settings';
          if (this.view === 'settings') this.devices = await this.phone.listDevices().catch(() => this.devices);
          return this.render();
        case 'close-panel':
          this.view = 'dialpad';
          return this.render();
        case 'auto-answer':
          this.phone.setAutoAnswer(event.target.checked);
          return this.render();
        case 'set-input': return void (await this.phone.setInputDevice(event.target.value));
        case 'set-output': return void (await this.phone.setOutputDevice(event.target.value));
        case 'login': return void (await this.login());
        case 'logout': return void (await this.logout());
        default: return;
      }
    } catch (err) {
      this.errorMessage = err.message;
      this.render();
    }
  }

  // ---- Branding (spec §11) ----------------------------------------------

  _brandingFromAttributes() {
    const b = {};
    if (this.hasAttribute('logo')) b.logo = this.getAttribute('logo');
    if (this.hasAttribute('company-name')) b.company_name = this.getAttribute('company-name');
    if (this.hasAttribute('primary-color')) b.primary_color = this.getAttribute('primary-color');
    if (this.hasAttribute('theme')) b.theme = this.getAttribute('theme');
    if (this.hasAttribute('hide-powered-by')) b.show_powered_by = false;
    return b;
  }

  _applyBrandingAttributes() {
    const colour = this.getAttribute('primary-color') ?? this.phone.config?.branding?.primary_color;
    if (colour) this.style.setProperty('--auso-primary', colour);
  }
}

function formatDuration(seconds) {
  const s = Math.max(0, seconds | 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function defineAusoPhoneElement(tag = 'auso-phone') {
  if (!customElements.get(tag)) customElements.define(tag, AusoPhoneElement);
  return tag;
}
