import { SIPClient } from './SIPClient.js';
import { RegistrationManager } from './RegistrationManager.js';
import { CallManager } from './CallManager.js';
import { TransferManager } from './TransferManager.js';
import { MediaManager } from './MediaManager.js';
import { RecordingManager } from './RecordingManager.js';
import { EventManager } from './EventManager.js';
import { SessionCoordinator, SessionRole } from './SessionCoordinator.js';
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

/**
 * What a companion tab is allowed to ask the owning tab to do.
 *
 * Anything absent here cannot be triggered from another tab, so a companion
 * cannot log the owner out, tear the phone down, or pull credentials out of it.
 */
const RELAYABLE_COMMANDS = new Set([
  'call', 'answer', 'reject', 'hangup',
  'hold', 'unhold', 'toggleHold',
  'mute', 'unmute', 'toggleMute',
  'sendDTMF',
  'transfer', 'completeTransfer', 'cancelTransfer', 'swapTransferLegs',
  'startRecording', 'stopRecording',
  'listDevices', 'setInputDevice', 'setOutputDevice', 'setVolume',
  'setAutoAnswer', 'attachCustomer',
]);

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
  /** Seconds between CRLF pings on the WSS. 0 disables them (SIP.js default). */
  wsKeepAliveInterval: 20,
  /** Seconds to wait for the server's echo before assuming a ping was lost. */
  wsKeepAliveDebounce: 10,
  /**
   * How long a tab must have been hidden before coming back is treated as a
   * reason to rebuild the transport. Short absences (an alt-tab, a click into
   * another window) do not warrant the cost; anything past this is long enough
   * for the OS to have reaped the socket and the browser to have frozen the
   * SIP.js timers we would otherwise rely on.
   */
  resumeMinHiddenMs: 30_000,
  /**
   * Coordinate tabs so only one of them registers the extension and the rest
   * mirror it. Without this every tab opens its own socket, and since the AOR
   * is `max_contacts=1` / `remove_existing=yes`, the newest tab's REGISTER
   * silently evicts the older one.
   */
  sessionSync: true,
  /** BroadcastChannel name; the extension is appended to scope it per agent. */
  sessionChannel: 'auso-phone',
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
    /** When the tab was last hidden, for the resume check. 0 = not hidden. */
    this._hiddenAt = 0;
    /** Guards against overlapping recoveries from stacked lifecycle events. */
    this._recovering = false;
    this._lifecycleHandlers = null;
    /** Cross-tab ownership. Null until `init()` builds one. */
    this.session = null;
    /** True while this tab is mirroring another tab's call rather than owning it. */
    this._companion = false;
    /** The companion's view of the phone, republished by the owning tab. */
    this._mirrored = null;
    /** Set while `login()` is settling the cross-tab election. */
    this._electing = false;

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
    this._installLifecycleWatch();
    this._installSession();
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

    const credentials = opts.credentials ?? (await this.fetchCredentials(opts));
    this.credentials = credentials;
    this.config.sip_domain = credentials.sip_domain;
    this.agent = credentials.agent ?? { extension: credentials.extension };

    if (credentials.branding) this.config.branding = mergeDeep(this.config.branding, credentials.branding);
    if (typeof credentials.auto_answer === 'boolean') this.setAutoAnswer(credentials.auto_answer);

    // Settle the cross-tab election before touching the network. Registering
    // from two tabs at once is exactly what evicts the first one from Asterisk.
    if (this.session) {
      if (this.session.role === null) {
        // The server is the authority on which extension this agent is, so let
        // it correct whatever the markup guessed before the channel is named.
        this.session.extension = credentials.extension;
        // Winning the election fires the role callback, and the callback
        // registers on promotion. Suppress it here or `login()` would register
        // twice against the same extension.
        this._electing = true;
        try {
          await this.session.join(this.config.sessionChannel);
        } finally {
          this._electing = false;
        }
      }
      if (this._companion) {
        this._adoptMirroredIdentity(credentials);
        log.info('another tab owns this extension — mirroring it instead of registering');
        this.events.emit(PhoneEvents.SESSION_ROLE, { role: SessionRole.COMPANION });
        return this.status();
      }
    }

    return this._register(credentials, opts);
  }

  /** The half of `login()` that actually owns a socket and a registration. */
  async _register(credentials, opts = {}) {
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

    const userAgent = await this.sip.connect(credentials, {
      iceServers: credentials.ice_servers ?? this.config.iceServers,
      iceGatheringTimeout: this.config.iceGatheringTimeout,
      traceSip: this.config.traceSip,
      keepAliveInterval: this.config.wsKeepAliveInterval,
      keepAliveDebounce: this.config.wsKeepAliveDebounce,
    });

    await this.registration.register(userAgent, {
      expires: credentials.register_expires ?? this.config.registerExpires,
      extension: credentials.extension,
    });

    this._scheduleCredentialRefresh(credentials);
    this.session?.startPublishing();
    return this.status();
  }

  /** Spec §13: logout → unregister → WSS disconnect. */
  async logout() {
    // A companion has no registration to tear down, and unregistering from here
    // would drop the other tab's call on the floor.
    if (this._companion) {
      this.session?.leave();
      this._companion = false;
      this._mirrored = null;
      return this.status();
    }

    clearTimeout(this._refreshTimer);
    this._refreshTimer = null;
    this.session?.stopPublishing();
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
    this._removeLifecycleWatch();
    this._removeSessionWatch();
    await this.logout().catch(() => {});
    this.session?.leave();
    this.session = null;
    this.calls.destroy();
    this.media.destroy();
    this.events.removeAll();
    this.initialised = false;
  }

  /**
   * Bring registration back in line with the transport, rebuilding the socket
   * only when the transport is genuinely suspect.
   *
   * A Registerer belongs to the UserAgent it was made from, so the transport
   * being rebuilt means the registration has to be rebuilt with it — refreshing
   * the old one would REGISTER into a disconnected object. When the same
   * UserAgent is still live a plain re-REGISTER is enough and much cheaper.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.force] rebuild the transport even if it looks healthy
   */
  async _ensureRegistration({ force = false } = {}) {
    if (!this.credentials) return this.status();
    // Only the owning tab has a registration to keep in line.
    if (this._companion) return this.status();
    if (!force && this.sip.isConnected && this.registration.isRegistered) return this.status();

    let userAgent = this.sip.userAgent;
    if (force || !this.sip.isConnected || !this.registration.isBoundTo(userAgent)) {
      userAgent = await this.sip.reconnectFresh(force ? 'resumed' : 'unhealthy', { notify: false });
    }

    if (this.registration.isBoundTo(userAgent) && this.registration.isRegistered) {
      await this.registration.refresh();
    } else {
      await this.registration.register(userAgent, {
        expires: this.credentials.register_expires ?? this.config.registerExpires,
        extension: this.credentials.extension,
      });
      this._scheduleCredentialRefresh(this.credentials);
    }
    return this.status();
  }

  /**
   * Watch the tab lifecycle and re-validate the phone when the agent comes back.
   *
   * A backgrounded tab has its timers throttled and its socket reaped by the OS.
   * Every SIP.js timer we would normally rely on — the re-REGISTER refresh, the
   * transport backoff — is a `setTimeout` that gets frozen along with everything
   * else, so coming back can leave a registration that exists only in this tab:
   * Asterisk dropped the contact while the UI still says "registered", and no
   * call can ever come in. Re-registering over that stale transport is precisely
   * the "tries to re-register, then disconnects" behaviour we are fixing, so
   * after a meaningful absence we rebuild the transport outright instead. It
   * costs one WSS connect plus one REGISTER and needs no liveness guesswork.
   */
  _installLifecycleWatch() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (this._lifecycleHandlers) return;

    const handlers = {
      visibilitychange: () => {
        if (document.hidden) this._hiddenAt = Date.now();
        else this._resumeFromHidden();
      },
      // A bfcache restore brings the whole JS heap back but every socket and
      // timer with it is gone, so the page looks alive while the phone is not.
      pageshow: (ev) => {
        if (ev.persisted) this._resumeFromHidden();
      },
      // Only ever does work after a real absence, since _hiddenAt is what gates
      // it — clicking into the same tab is a no-op.
      focus: () => this._resumeFromHidden(),
      online: () => this._resumeFromHidden(),
    };

    document.addEventListener('visibilitychange', handlers.visibilitychange);
    for (const name of ['pageshow', 'focus', 'online']) {
      window.addEventListener(name, handlers[name]);
    }
    this._lifecycleHandlers = handlers;
  }

  _removeLifecycleWatch() {
    const handlers = this._lifecycleHandlers;
    if (!handlers) return;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handlers.visibilitychange);
    }
    if (typeof window !== 'undefined') {
      for (const name of ['pageshow', 'focus', 'online']) {
        window.removeEventListener(name, handlers[name]);
      }
    }
    this._lifecycleHandlers = null;
  }

  async _resumeFromHidden() {
    if (this._recovering) return;
    if (!this.credentials) return;
    // The owning tab owns the recovery story; a companion rebuilding a socket
    // here would register over the top of it.
    if (this._companion) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    const hiddenMs = this._hiddenAt ? Date.now() - this._hiddenAt : 0;
    this._hiddenAt = 0;
    if (hiddenMs < this.config.resumeMinHiddenMs) return;

    // Bytes are still moving if a call is up, which means the socket is fine.
    // Rebuilding now would drop the customer on the floor.
    if (this.calls.list().length > 0) {
      log.info(`resumed after ${Math.round(hiddenMs / 1000)}s with a call in progress — transport left alone`);
      return;
    }

    this._recovering = true;
    try {
      log.info(`resumed after ${Math.round(hiddenMs / 1000)}s hidden — revalidating registration`);
      await this._ensureRegistration({ force: true });
    } catch (err) {
      log.error('resume re-registration failed', err);
    } finally {
      this._recovering = false;
    }
  }

  // ---- Cross-tab session -------------------------------------------------

  /**
   * Build the coordinator that stops every tab registering the same extension.
   *
   * Only one tab can hold a WebRTC call, so the rest mirror it: the owner
   * publishes `status()` once a second and on every state change, and a
   * companion relays control commands back to it. Registration itself still
   * happens in `login()`, once the role is known.
   */
  _installSession() {
    if (!this.config.sessionSync || this.session) return;

    this.session = new SessionCoordinator({
      extension: this.config.extension ?? null,
      getStatus: () => this._localStatus(),
      onCommand: (action, args) => this._runRelayed(action, args),
      onState: (state) => {
        this._mirrored = state;
        this.events.emit(PhoneEvents.SESSION_STATE, { status: state });
      },
      onRole: (role) => this._onSessionRole(role),
    });

    this._installSessionWatch();
  }

  /**
   * Release the lease when the tab goes away, so peers promote straight away
   * instead of waiting out the stale timeout.
   *
   * A `pagehide` carrying `persisted` means the page is going into the bfcache
   * and will come back with its sockets and heap intact, so the lease has to
   * stay put. A real close means the socket is gone, and any call on it died
   * with it — there is no way to hand a peer connection to another tab.
   */
  _installSessionWatch() {
    if (typeof window === 'undefined' || this._sessionPageHide) return;

    this._sessionPageHide = (ev) => {
      if (ev.persisted) return;
      if (this.calls.list().length > 0) {
        log.warn('tab closing with a call in progress — the call cannot survive it');
      }
      this.session?.leave();
    };
    window.addEventListener('pagehide', this._sessionPageHide);
  }

  _removeSessionWatch() {
    if (typeof window === 'undefined' || !this._sessionPageHide) return;
    window.removeEventListener('pagehide', this._sessionPageHide);
    this._sessionPageHide = null;
  }

  /**
   * A companion took over because the owning tab died. Register properly so the
   * phone is usable again; whatever call was up is gone and cannot be restored.
   */
  async _onSessionRole(role) {
    this._companion = role === SessionRole.COMPANION;
    this._mirrored = null;
    this.events.emit(PhoneEvents.SESSION_ROLE, { role, recovered: true });
    this.session?.publish();

    if (this._companion || !this.credentials) return;
    // Mid-election means `login()` is about to register on its own terms.
    if (this._electing) return;
    try {
      await this._register(this.credentials);
    } catch (err) {
      log.error('could not register after taking over from the closed tab', err);
      this.events.emit(PhoneEvents.ERROR, { scope: 'session', message: err.message, fatal: false });
    }
  }

  /** A companion still needs the extension and branding to render like the owner. */
  _adoptMirroredIdentity(credentials) {
    this.credentials = { ...credentials };
    this.config.sip_domain = credentials.sip_domain;
    this.agent = credentials.agent ?? { extension: credentials.extension };
    if (credentials.branding) this.config.branding = mergeDeep(this.config.branding, credentials.branding);
  }

  /**
   * Hand a command to the owning tab when this one is only mirroring.
   *
   * @returns {Promise<unknown>|null} null when this tab is the owner and should
   *   run the command itself
   */
  _relay(action, args) {
    if (!this._companion) return null;
    return this.session.command(action, args);
  }

  /** Owner-side execution of a companion's command. */
  _runRelayed(action, args) {
    if (!RELAYABLE_COMMANDS.has(action)) {
      throw new Error(`"${action}" cannot be run from another tab`);
    }
    return this[action](...args);
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
    return this._relay('call', [number, opts]) ?? this._callLocal(number, opts);
  }

  _callLocal(number, opts) {
    this._requireRegistered();
    return this.calls.call(this.sip.userAgent, number, opts);
  }

  answer(callId) {
    return this._relay('answer', [callId]) ?? this.calls.answer(callId);
  }

  reject(callId, opts) {
    return this._relay('reject', [callId, opts]) ?? this.calls.reject(callId, opts);
  }

  hangup(callId) {
    return this._relay('hangup', [callId]) ?? this.calls.hangup(callId);
  }

  hold(callId) {
    return this._relay('hold', [callId]) ?? this.calls.hold(callId, true);
  }

  unhold(callId) {
    return this._relay('unhold', [callId]) ?? this.calls.hold(callId, false);
  }

  toggleHold(callId) {
    return this._relay('toggleHold', [callId]) ?? this._toggleHoldLocal(callId);
  }

  _toggleHoldLocal(callId) {
    const call = callId ? this.calls.calls.get(callId) : this.calls.activeCall;
    if (!call) throw new Error('No active call');
    return this.calls.hold(call.id, !call.held);
  }

  mute(callId) {
    return this._relay('mute', [callId]) ?? this.calls.mute(callId, true);
  }

  unmute(callId) {
    return this._relay('unmute', [callId]) ?? this.calls.mute(callId, false);
  }

  toggleMute(callId) {
    return this._relay('toggleMute', [callId]) ?? this._toggleMuteLocal(callId);
  }

  _toggleMuteLocal(callId) {
    const call = callId ? this.calls.calls.get(callId) : this.calls.activeCall;
    if (!call) throw new Error('No active call');
    return this.calls.mute(call.id, !call.muted);
  }

  sendDTMF(tones, opts) {
    return this._relay('sendDTMF', [tones, opts]) ?? this.calls.sendDTMF(undefined, tones, opts);
  }

  /**
   * Spec §12: `AusoPhone.transfer("2005")`.
   * Blind by default; pass `{ type: 'attended' }` to start a consultation.
   */
  transfer(target, opts = {}) {
    return this._relay('transfer', [target, opts]) ?? this._transferLocal(target, opts);
  }

  _transferLocal(target, opts = {}) {
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
    return this._relay('completeTransfer', []) ?? this.transfers.completeAttended();
  }

  cancelTransfer() {
    return this._relay('cancelTransfer', []) ?? this.transfers.cancelAttended();
  }

  swapTransferLegs() {
    return this._relay('swapTransferLegs', []) ?? this.transfers.toggleConsultation();
  }

  /** Spec §6: `phone.setAutoAnswer(true)`. */
  setAutoAnswer(enabled, opts) {
    return this._relay('setAutoAnswer', [enabled, opts]) ?? this.calls.setAutoAnswer(enabled, opts);
  }

  getAutoAnswer() {
    return this._companion && this._mirrored
      ? this._mirrored.auto_answer
      : this.calls.autoAnswer;
  }

  // ---- Recording (spec §10, optional) ------------------------------------

  startRecording(callId) {
    return this._relay('startRecording', [callId]) ?? this._startRecordingLocal(callId);
  }

  _startRecordingLocal(callId) {
    const call = callId ? this.calls.calls.get(callId) : this.calls.activeCall;
    if (!call) throw new Error('No active call');
    return this.recorder.start(call);
  }

  stopRecording(callId, opts) {
    return this._relay('stopRecording', [callId, opts]) ?? this._stopRecordingLocal(callId, opts);
  }

  _stopRecordingLocal(callId, opts) {
    const call = callId ? this.calls.calls.get(callId) : this.calls.activeCall;
    return this.recorder.stop(call?.id ?? callId, opts);
  }

  // ---- Media -------------------------------------------------------------

  // Device and volume changes relay to the owning tab as well: the microphone
  // and speakers in use belong to whoever holds the call, so setting them here
  // has to be applied there to mean anything.

  listDevices() {
    return this._relay('listDevices', []) ?? this.media.enumerate();
  }

  setInputDevice(deviceId) {
    return this._relay('setInputDevice', [deviceId]) ?? this.media.setInputDevice(deviceId);
  }

  setOutputDevice(deviceId) {
    return this._relay('setOutputDevice', [deviceId]) ?? this.media.setOutputDevice(deviceId);
  }

  setVolume(v) {
    return this._relay('setVolume', [v]) ?? this.media.setVolume(v);
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
    // The Call object lives in the owning tab, so the decoration has to happen
    // there or the owner would overwrite it on its next state publish.
    return this._relay('attachCustomer', [callId, customer]) ?? this._attachCustomerLocal(callId, customer);
  }

  _attachCustomerLocal(callId, customer) {
    const call = this.calls.calls.get(callId);
    if (!call) return null;
    call.customer = customer;
    this.events.emit(PhoneEvents.CALL_UPDATED, { call: call.toJSON() });
    return call.toJSON();
  }

  // ---- Introspection -----------------------------------------------------

  /**
   * Everything a Livewire component needs to render, in one plain object.
   *
   * A companion tab answers with the owning tab's published state, so the same
   * view code renders the same call in every tab.
   */
  status() {
    if (this._companion && this._mirrored) {
      return { ...this._mirrored, initialised: true, session: this._sessionInfo() };
    }
    return { ...this._localStatus(), session: this._sessionInfo() };
  }

  _localStatus() {
    return {
      initialised: this.initialised,
      connection: this.sip.connectionState,
      registration: this.registration.state,
      registered: this.registration.isRegistered,
      /** True while a backgrounded-tab recovery is rebuilding the socket. */
      recovering: this._recovering,
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

  _sessionInfo() {
    return {
      /** 'owner' holds the socket and the call; 'companion' mirrors it. */
      role: this._companion ? SessionRole.COMPANION : SessionRole.OWNER,
      mirrored: this._companion,
      tab_id: this.session?.id ?? null,
      enabled: Boolean(this.session?.enabled),
    };
  }

  getCalls() {
    return this._companion && this._mirrored ? this._mirrored.calls : this.calls.list().map((c) => c.toJSON());
  }

  getActiveCall() {
    if (this._companion && this._mirrored) return this._mirrored.active_call;
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

    // Push every state change to companion tabs now instead of leaving them to
    // the next heartbeat, so an incoming call lights up in all of them at once.
    for (const event of ALL_EVENTS) {
      if (event === PhoneEvents.SESSION_STATE || event === PhoneEvents.SESSION_ROLE) continue;
      this.events.on(event, () => this.session?.publish());
    }

    // Websocket came back after a drop → re-REGISTER so we can take calls again.
    this.sip.onReconnected = () => {
      log.info('transport recovered, refreshing registration');
      this._ensureRegistration().catch((err) => log.warn('re-registration after reconnect failed', err));
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
    if (this._companion) return this.credentials;
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
      // A failed re-REGISTER here means the registrar never heard us, which is
      // what a backgrounded tab looks like from here. Hand off to the recovery
      // path so we rebuild the socket rather than stay quietly unregistered.
      const ok = await this.registration.refresh();
      this._scheduleCredentialRefresh(credentials);
      if (!ok) {
        log.warn('re-register after credential swap failed — rebuilding transport');
        await this._ensureRegistration();
      }
      return credentials;
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
