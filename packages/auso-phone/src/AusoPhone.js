import { SIPClient } from './SIPClient.js';
import { RegistrationManager } from './RegistrationManager.js';
import { CallManager } from './CallManager.js';
import { TransferManager } from './TransferManager.js';
import { MediaManager } from './MediaManager.js';
import { RecordingManager } from './RecordingManager.js';
import { EventManager } from './EventManager.js';
import { createLogger, setLogLevel } from './logger.js';
import {
  ALL_EVENTS,
  CallState,
  ConnectionState,
  Direction,
  PhoneEvents,
  RegistrationState,
} from './events.js';

const log = createLogger('AusoPhone');

const DEFAULT_CONFIG = {
  /** Laravel endpoint that returns short-lived SIP credentials (spec §2). */
  credentialsUrl: '/api/phone/credentials',
  /** Laravel endpoint for the customer screen-pop (spec §5). Optional. */
  lookupUrl: null,
  /** Laravel endpoint that receives a call record on hangup. Optional. */
  callRecordUrl: null,
  /** Sent with every request to Laravel — put the CSRF/bearer token here. */
  headers: {},
  credentialsMode: 'same-origin',
  /** SIP domain; normally supplied by Laravel with the credentials. */
  sip_domain: null,
  iceServers: [],
  iceGatheringTimeout: 2000,
  registerExpires: 300,
  autoAnswer: false,
  autoAnswerDelayMs: 0,
  /** Extra Web Audio noise gate. ON by default so background noise is actually
   * suppressed. Routing through Web Audio can weaken the browser's native echo
   * cancellation, so it can be disabled via `init({ noiseGate: false })`. */
  noiseGate: true,
  /** Re-fetch credentials this many seconds before the token expires. */
  credentialRefreshLeadSeconds: 60,
  traceSip: false,
  logLevel: 'info',
  branding: {
    logo: null,
    company_name: 'Auso Call Hub',
    primary_color: '#0f766e',
    show_powered_by: true,
    theme: 'default',
  },
  recording: {
    /** Browser recording is opt-in — Asterisk MixMonitor is primary (spec §10). */
    enabled: false,
    autoStart: false,
    autoUpload: true,
    uploadUrl: '/api/phone/recordings',
  },
};

/**
 * The single object Laravel/Livewire talks to.
 *
 *   AusoPhone.init({ credentialsUrl: '/api/phone/credentials' })
 *   await AusoPhone.login({ extension: '2002' })
 *   AusoPhone.on('incoming', call => screenPop(call.call.cli))
 *   AusoPhone.call('0772615908')
 *
 * Everything below the facade (SIP.js, WebRTC, media) is deliberately invisible
 * to the CRM, per spec §14.
 */
export class AusoPhone {
  constructor() {
    this.config = structuredCloneish(DEFAULT_CONFIG);
    this.initialised = false;
    this.agent = null;
    this.credentials = null;
    this.credentialsExpireAt = null;
    this._refreshTimer = null;

    this.events = new EventManager({ domTarget: typeof window !== 'undefined' ? window : null });
    this.media = new MediaManager();
    this.sip = new SIPClient({ events: this.events });
    this.registration = new RegistrationManager({ events: this.events });
    this.calls = new CallManager({ events: this.events, media: this.media, config: this.config });
    this.transfers = new TransferManager({
      events: this.events,
      calls: this.calls,
      media: this.media,
      config: this.config,
    });
    this.recorder = new RecordingManager({ events: this.events, config: this.config });

    this._wireInternalPlumbing();
  }

  // ---- Lifecycle ---------------------------------------------------------

  /** Spec §11: branding and endpoints are configured here. */
  init(config = {}) {
    this.config = mergeDeep(this.config, config);
    // The managers hold a reference to this.config, so keep the identity stable.
    this.calls.config = this.config;
    this.transfers.config = this.config;
    this.recorder.config = this.config;

    setLogLevel(this.config.logLevel);
    this.media.attach();
    this.media.setNoiseGate(Boolean(this.config.noiseGate));
    this.calls.setAutoAnswer(this.config.autoAnswer, { delayMs: this.config.autoAnswerDelayMs });
    this.initialised = true;
    log.info('initialised', { credentialsUrl: this.config.credentialsUrl });
    return this;
  }

  /**
   * Spec §2/§13: the whole automatic-registration chain in one call.
   * Laravel authenticates → returns credentials → connect WSS → REGISTER.
   *
   * @param {object} [opts]
   * @param {string} [opts.extension] hint for Laravel; the server decides
   * @param {object} [opts.credentials] bypass the fetch and use these directly
   * @param {boolean} [opts.requestMedia] prompt for the mic now (default true)
   */
  async login(opts = {}) {
    if (!this.initialised) this.init();

    if (opts.requestMedia !== false) {
      try {
        await this.media.requestPermission();
      } catch (err) {
        // Registration still works without a mic; calls won't. Surface it now
        // rather than failing mysteriously on the first INVITE.
        //
        // An insecure origin is unrecoverable — no amount of retrying will
        // produce a microphone — so show it prominently rather than as a
        // dismissible warning the agent will scroll past.
        const insecure = typeof window !== 'undefined' && !window.isSecureContext;
        this.events.emit(PhoneEvents.ERROR, {
          scope: 'media',
          message: insecure ? err.message : `Microphone unavailable: ${err.message}`,
          fatal: insecure,
        });
      }
    }

    const credentials = opts.credentials ?? (await this.fetchCredentials(opts));
    this.credentials = credentials;
    this.config.sip_domain = credentials.sip_domain;
    this.agent = credentials.agent ?? { extension: credentials.extension };

    if (credentials.branding) this.config.branding = mergeDeep(this.config.branding, credentials.branding);
    if (typeof credentials.auto_answer === 'boolean') this.setAutoAnswer(credentials.auto_answer);

    const userAgent = await this.sip.connect(credentials, {
      iceServers: credentials.ice_servers ?? this.config.iceServers,
      iceGatheringTimeout: this.config.iceGatheringTimeout,
      traceSip: this.config.traceSip,
    });

    await this.registration.register(userAgent, {
      expires: credentials.register_expires ?? this.config.registerExpires,
      extension: credentials.extension,
    });

    this._scheduleCredentialRefresh(credentials);
    return this.status();
  }

  /** Spec §13: logout → unregister → WSS disconnect. */
  async logout() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = null;
    await this.recorder.abortAll();
    await this.calls.hangupAll();
    await this.registration.unregister();
    await this.registration.dispose();
    await this.sip.disconnect({ permanent: true });
    this.credentials = null;
    this.agent = null;
    return this.status();
  }

  /** Free every browser resource. Call from a beforeunload handler. */
  async destroy() {
    await this.logout().catch(() => {});
    this.calls.destroy();
    this.media.destroy();
    this.events.removeAll();
    this.initialised = false;
  }

  /**
   * Ask Laravel for short-lived SIP credentials.
   * Spec §2 security note: the permanent SIP password never reaches the page —
   * the server issues a temporary one (or a per-session PJSIP endpoint).
   */
  async fetchCredentials({ extension } = {}) {
    const url = new URL(this.config.credentialsUrl, window.location.origin);
    if (extension) url.searchParams.set('extension', extension);

    const res = await fetch(url, {
      method: 'GET',
      credentials: this.config.credentialsMode,
      headers: { Accept: 'application/json', ...this.config.headers },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Could not get SIP credentials (HTTP ${res.status}) ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    for (const field of ['extension', 'sip_domain', 'ws_url', 'password']) {
      if (!data[field]) throw new Error(`Credential response is missing "${field}"`);
    }
    return data;
  }

  // ---- Commands (spec §4 / §12) -----------------------------------------

  /** `AusoPhone.call("0772615908")` */
  call(number, opts) {
    this._requireRegistered();
    return this.calls.call(this.sip.userAgent, number, opts);
  }

  answer(callId) {
    return this.calls.answer(callId);
  }

  reject(callId, opts) {
    return this.calls.reject(callId, opts);
  }

  hangup(callId) {
    return this.calls.hangup(callId);
  }

  hold(callId) {
    return this.calls.hold(callId, true);
  }

  unhold(callId) {
    return this.calls.hold(callId, false);
  }

  toggleHold(callId) {
    const call = callId ? this.calls.calls.get(callId) : this.calls.activeCall;
    if (!call) throw new Error('No active call');
    return this.calls.hold(call.id, !call.held);
  }

  mute(callId) {
    return this.calls.mute(callId, true);
  }

  unmute(callId) {
    return this.calls.mute(callId, false);
  }

  toggleMute(callId) {
    const call = callId ? this.calls.calls.get(callId) : this.calls.activeCall;
    if (!call) throw new Error('No active call');
    return this.calls.mute(call.id, !call.muted);
  }

  sendDTMF(tones, opts) {
    return this.calls.sendDTMF(undefined, tones, opts);
  }

  /**
   * Spec §12: `AusoPhone.transfer("2005")`.
   * Blind by default; pass `{ type: 'attended' }` to start a consultation.
   */
  transfer(target, opts = {}) {
    this._requireRegistered();
    if (opts.type === 'attended') {
      return this.transfers.startAttended(this.sip.userAgent, target, opts.callId);
    }
    return this.transfers.blindTransfer(this.sip.userAgent, target, opts.callId);
  }

  attendedTransfer(target, callId) {
    return this.transfer(target, { type: 'attended', callId });
  }

  completeTransfer() {
    return this.transfers.completeAttended();
  }

  cancelTransfer() {
    return this.transfers.cancelAttended();
  }

  swapTransferLegs() {
    return this.transfers.toggleConsultation();
  }

  /** Spec §6: `phone.setAutoAnswer(true)`. */
  setAutoAnswer(enabled, opts) {
    return this.calls.setAutoAnswer(enabled, opts);
  }

  getAutoAnswer() {
    return this.calls.autoAnswer;
  }

  // ---- Recording (spec §10, optional) ------------------------------------

  startRecording(callId) {
    const call = callId ? this.calls.calls.get(callId) : this.calls.activeCall;
    if (!call) throw new Error('No active call');
    return this.recorder.start(call);
  }

  stopRecording(callId, opts) {
    const call = callId ? this.calls.calls.get(callId) : this.calls.activeCall;
    return this.recorder.stop(call?.id ?? callId, opts);
  }

  // ---- Media -------------------------------------------------------------

  listDevices() {
    return this.media.enumerate();
  }

  setInputDevice(deviceId) {
    return this.media.setInputDevice(deviceId);
  }

  setOutputDevice(deviceId) {
    return this.media.setOutputDevice(deviceId);
  }

  setVolume(v) {
    return this.media.setVolume(v);
  }

  // ---- CRM helpers -------------------------------------------------------

  /**
   * Spec §5: look the CLI up in Laravel and attach the result to the call so
   * the UI can screen-pop. No-op when `lookupUrl` isn't configured.
   */
  async lookupCustomer(cli, callId) {
    if (!this.config.lookupUrl) return null;
    const url = new URL(this.config.lookupUrl, window.location.origin);
    url.searchParams.set('phone', cli);
    const res = await fetch(url, {
      credentials: this.config.credentialsMode,
      headers: { Accept: 'application/json', ...this.config.headers },
    });
    if (!res.ok) return null;
    const customer = await res.json().catch(() => null);
    if (customer && callId) this.attachCustomer(callId, customer);
    return customer;
  }

  /** Let the CRM decorate a call with whatever it looked up. */
  attachCustomer(callId, customer) {
    const call = this.calls.calls.get(callId);
    if (!call) return null;
    call.customer = customer;
    this.events.emit(PhoneEvents.CALL_UPDATED, { call: call.toJSON() });
    return call.toJSON();
  }

  // ---- Introspection -----------------------------------------------------

  /** Everything a Livewire component needs to render, in one plain object. */
  status() {
    return {
      initialised: this.initialised,
      connection: this.sip.connectionState,
      registration: this.registration.state,
      registered: this.registration.isRegistered,
      extension: this.credentials?.extension ?? null,
      agent: this.agent,
      auto_answer: this.calls.autoAnswer,
      branding: this.config.branding,
      active_call: this.calls.activeCall?.toJSON() ?? null,
      calls: this.calls.list().map((c) => c.toJSON()),
      transfer: this.transfers.pending,
      credentials_expire_at: this.credentialsExpireAt,
    };
  }

  getCalls() {
    return this.calls.list().map((c) => c.toJSON());
  }

  getActiveCall() {
    return this.calls.activeCall?.toJSON() ?? null;
  }

  eventLog() {
    return [...this.events.history];
  }

  // ---- Events ------------------------------------------------------------

  on(event, handler) {
    return this.events.on(event, handler);
  }

  once(event, handler) {
    return this.events.once(event, handler);
  }

  off(event, handler) {
    return this.events.off(event, handler);
  }

  // ---- Internals ---------------------------------------------------------

  _wireInternalPlumbing() {
    // INVITE from Asterisk → CallManager.
    this.sip.onInvite = (invitation) => this.calls.handleInvite(invitation);

    // Websocket came back after a drop → re-REGISTER so we can take calls again.
    this.sip.onReconnected = () => {
      log.info('transport recovered, refreshing registration');
      this.registration.refresh();
    };

    // Token expired mid-session → get a fresh one and re-register.
    this.registration.onCredentialsRejected = () => {
      log.warn('credentials rejected — refreshing from Laravel');
      this._refreshCredentials().catch((err) => {
        this.events.emit(PhoneEvents.ERROR, { scope: 'auth', message: err.message, fatal: true });
      });
    };

    // Screen-pop: as soon as an INVITE lands, ask Laravel who is calling.
    this.events.on(PhoneEvents.INCOMING, ({ call }) => {
      if (!this.config.lookupUrl) return;
      this.lookupCustomer(call.cli, call.call_id).catch((err) => log.warn('lookup failed', err));
    });

    // Optional browser recording that follows the call automatically.
    this.events.on(PhoneEvents.ANSWERED, ({ call }) => {
      if (!this.config.recording?.enabled || !this.config.recording?.autoStart) return;
      try {
        this.startRecording(call.call_id);
      } catch (err) {
        log.warn('auto recording failed to start', err);
      }
    });

    this.events.on(PhoneEvents.HANGUP, ({ call }) => {
      this.transfers.notifyCallEnded(call.call_id);
      if (this.recorder.sessions.has(call.call_id)) {
        this.recorder.stop(call.call_id).catch((err) => log.warn('recording stop failed', err));
      }
      this._postCallRecord(call);
    });
  }

  /** Spec §10: write the CDR row back to Laravel. */
  _postCallRecord(call) {
    if (!this.config.callRecordUrl) return;
    const body = {
      call_id: call.call_id,
      direction: call.direction,
      customer_number: call.cli,
      extension: this.credentials?.extension ?? null,
      start_time: call.created_at,
      answer_time: call.answered_at,
      end_time: call.ended_at,
      duration: call.duration,
      end_reason: call.end_reason,
      customer: call.customer,
    };
    // keepalive so the record still lands if the agent closes the tab.
    fetch(this.config.callRecordUrl, {
      method: 'POST',
      credentials: this.config.credentialsMode,
      keepalive: true,
      headers: { 'Content-Type': 'application/json', ...this.config.headers },
      body: JSON.stringify(body),
    }).catch((err) => log.warn('call record post failed', err));
  }

  _scheduleCredentialRefresh(credentials) {
    clearTimeout(this._refreshTimer);
    const ttl = credentials.expires_in ?? credentials.ttl ?? null;
    if (!ttl) {
      this.credentialsExpireAt = null;
      return;
    }
    this.credentialsExpireAt = new Date(Date.now() + ttl * 1000).toISOString();
    const lead = this.config.credentialRefreshLeadSeconds;
    const delay = Math.max(10, ttl - lead) * 1000;
    log.info(`credentials refresh scheduled in ${Math.round(delay / 1000)}s`);
    this._refreshTimer = setTimeout(() => {
      this._refreshCredentials().catch((err) => log.error('credential refresh failed', err));
    }, delay);
  }

  /**
   * Swap in a new short-lived password without dropping calls where possible.
   * A live call keeps its dialog; only the registration is redone.
   */
  async _refreshCredentials() {
    const credentials = await this.fetchCredentials({ extension: this.credentials?.extension });
    this.credentials = credentials;
    if (this.sip.userAgent) {
      // Update the auth the UserAgent uses for the next REGISTER challenge.
      const ua = this.sip.userAgent;
      ua.options.authorizationPassword = credentials.password;
      ua.options.authorizationUsername = credentials.auth_user || credentials.extension;
      if (ua.userAgentCore?.configuration) {
        ua.userAgentCore.configuration.authenticationConfiguration = {
          ...(ua.userAgentCore.configuration.authenticationConfiguration ?? {}),
          username: credentials.auth_user || credentials.extension,
          password: credentials.password,
        };
      }
      await this.registration.refresh();
    }
    this._scheduleCredentialRefresh(credentials);
    return credentials;
  }

  _requireRegistered() {
    if (!this.registration.isRegistered) {
      throw new Error('Phone is not registered — call AusoPhone.login() first');
    }
  }
}

/** Singleton, matching `window.AusoPhone` in spec §12. */
export const phone = new AusoPhone();

export {
  PhoneEvents,
  CallState,
  Direction,
  RegistrationState,
  ConnectionState,
  ALL_EVENTS,
  DEFAULT_CONFIG,
};

function mergeDeep(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object'
      ? mergeDeep(base[k], v)
      : v;
  }
  return out;
}

function structuredCloneish(obj) {
  return JSON.parse(JSON.stringify(obj));
}
