import { Registerer, RegistererState } from 'sip.js';
import { createLogger } from './logger.js';
import { PhoneEvents, RegistrationState } from './events.js';

const log = createLogger('RegistrationManager');

/**
 * SIP REGISTER lifecycle (spec §2 and §13).
 *
 * The agent never types SIP credentials: Laravel hands them over at login and
 * this class turns them into a registration, keeps it refreshed, and tears it
 * down on logout so the Asterisk endpoint goes unavailable immediately.
 */
export class RegistrationManager {
  constructor({ events }) {
    this.events = events;
    /** @type {Registerer|null} */
    this.registerer = null;
    this.state = RegistrationState.UNREGISTERED;
    this.expires = 300;
    this.extension = null;
    this._stateListener = null;
    /** Set when a 401/403 means the token expired and Laravel must re-issue. */
    this.onCredentialsRejected = null;
  }

  get isRegistered() {
    return this.state === RegistrationState.REGISTERED;
  }

  /**
   * @param {import('sip.js').UserAgent} userAgent
   * @param {object} opts
   * @param {number} [opts.expires] registration expiry in seconds
   * @param {string} [opts.extension] for event payloads
   */
  async register(userAgent, opts = {}) {
    this.expires = opts.expires ?? this.expires;
    this.extension = opts.extension ?? this.extension;

    if (this.registerer) await this.dispose();

    this.registerer = new Registerer(userAgent, {
      expires: this.expires,
      // Asterisk is happy with the default Contact; a stable instance id keeps
      // re-registrations from creating duplicate contacts across reconnects.
      regId: 1,
      instanceId: getInstanceId(),
    });

    this._stateListener = (state) => this._handleStateChange(state);
    this.registerer.stateChange.addListener(this._stateListener);

    this._setState(RegistrationState.REGISTERING);

    await this.registerer.register({
      requestDelegate: {
        onReject: (response) => {
          const code = response?.message?.statusCode;
          const reason = response?.message?.reasonPhrase || 'Registration rejected';
          log.error(`REGISTER rejected ${code} ${reason}`);
          this._setState(RegistrationState.FAILED, { code, reason });
          if ((code === 401 || code === 403 || code === 407) && this.onCredentialsRejected) {
            this.onCredentialsRejected({ code, reason });
          }
        },
      },
    });
  }

  /** Spec §13: logout must actively unregister, not just close the socket. */
  async unregister() {
    if (!this.registerer) return;
    try {
      await this.registerer.unregister();
    } catch (err) {
      log.warn('unregister failed', err);
    }
  }

  async dispose() {
    if (!this.registerer) return;
    if (this._stateListener) {
      this.registerer.stateChange.removeListener(this._stateListener);
      this._stateListener = null;
    }
    try {
      await this.registerer.dispose();
    } catch (err) {
      log.debug('registerer dispose', err);
    }
    this.registerer = null;
    this._setState(RegistrationState.UNREGISTERED);
  }

  /** Re-REGISTER after the websocket comes back up. */
  async refresh() {
    if (!this.registerer) return;
    try {
      await this.registerer.register();
    } catch (err) {
      log.warn('re-register failed', err);
    }
  }

  _handleStateChange(state) {
    switch (state) {
      case RegistererState.Registered:
        this._setState(RegistrationState.REGISTERED);
        break;
      case RegistererState.Unregistered:
        // Don't downgrade a FAILED state into a plain unregistered one; the CRM
        // needs to keep showing the auth error.
        if (this.state !== RegistrationState.FAILED) {
          this._setState(RegistrationState.UNREGISTERED);
        }
        break;
      case RegistererState.Terminated:
        this._setState(RegistrationState.UNREGISTERED, { terminated: true });
        break;
      default:
        break;
    }
  }

  _setState(state, extra = {}) {
    if (this.state === state && !Object.keys(extra).length) return;
    this.state = state;
    const payload = { extension: this.extension, expires: this.expires, ...extra };
    if (state === RegistrationState.REGISTERED) this.events.emit(PhoneEvents.REGISTERED, payload);
    else if (state === RegistrationState.FAILED) this.events.emit(PhoneEvents.REGISTRATION_FAILED, payload);
    else if (state === RegistrationState.UNREGISTERED) this.events.emit(PhoneEvents.UNREGISTERED, payload);
  }
}

/**
 * A per-browser-profile UUID so Asterisk sees the same +sip.instance across
 * reloads instead of accumulating stale contacts.
 */
function getInstanceId() {
  const KEY = 'ausophone.instanceId';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID?.() ?? fallbackUuid());
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return fallbackUuid();
  }
}

function fallbackUuid() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
