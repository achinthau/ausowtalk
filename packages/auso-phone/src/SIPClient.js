import { UserAgent } from 'sip.js';
import { createLogger } from './logger.js';
import { ConnectionState, PhoneEvents } from './events.js';

const log = createLogger('SIPClient');

/**
 * Owns the SIP.js UserAgent and the WSS transport (spec §2: "Connect WSS").
 *
 * Responsibilities stop at the transport: registration lives in
 * RegistrationManager and call handling in CallManager. This split keeps a
 * dropped websocket from tearing down call state we might still recover.
 */
export class SIPClient {
  /**
   * @param {object} deps
   * @param {import('./EventManager.js').EventManager} deps.events
   */
  constructor({ events }) {
    this.events = events;
    /** @type {UserAgent|null} */
    this.userAgent = null;
    this.credentials = null;
    this.connectionState = ConnectionState.DISCONNECTED;
    /** Options the last connect() was called with, so a rebuild is identical. */
    this._connectOptions = {};

    this.reconnect = {
      attempts: 0,
      timer: null,
      max: 10,
      baseMs: 1000,
      maxMs: 30000,
      enabled: true,
      /** Soft attempts tolerated before escalating to a full rebuild. */
      freshAfter: 2,
    };
    /** Set by AusoPhone so an incoming INVITE reaches CallManager. */
    this.onInvite = null;
    /** Called after an unexpected drop once the transport is back. */
    this.onReconnected = null;
  }

  get isConnected() {
    return this.connectionState === ConnectionState.CONNECTED;
  }

  /**
   * @param {object} credentials
   * @param {string} credentials.extension    e.g. "2002"
   * @param {string} credentials.sip_domain   e.g. "pbx.ausoworld.com"
   * @param {string} credentials.ws_url       e.g. "wss://pbx.ausoworld.com:8089/ws"
   * @param {string} credentials.password     short-lived password issued by Laravel
   * @param {string} [credentials.auth_user]  when the SIP auth user differs from the extension
   * @param {string} [credentials.display_name]
   * @param {object} [options]
   * @param {RTCIceServer[]} [options.iceServers]
   * @param {number} [options.iceGatheringTimeout]
   * @param {string} [options.userAgentString]
   * @param {boolean} [options.traceSip]
   * @param {number} [options.keepAliveInterval] seconds between CRLF pings
   * @param {number} [options.keepAliveDebounce]  seconds to await the echo
   */
  async connect(credentials, options = {}) {
    if (this.userAgent) await this.disconnect();
    this.credentials = credentials;
    this._connectOptions = options;

    const uri = UserAgent.makeURI(`sip:${credentials.extension}@${credentials.sip_domain}`);
    if (!uri) throw new Error(`Invalid SIP URI for extension ${credentials.extension}`);

    this._setConnectionState(ConnectionState.CONNECTING);

    this.userAgent = new UserAgent({
      uri,
      displayName: credentials.display_name || credentials.extension,
      authorizationUsername: credentials.auth_user || credentials.extension,
      authorizationPassword: credentials.password,
      // Asterisk's PJSIP WebSocket transport terminates on wss://host:8089/ws
      transportOptions: {
        server: credentials.ws_url,
        traceSip: options.traceSip ?? false,
        // We drive reconnection ourselves so the CRM gets clean events.
        connectionTimeout: 10,
        // SIP.js defaults these to 0, which switches the CRLF keep-alive off
        // entirely. A backgrounded tab has its timers throttled and its socket
        // reaped by the OS, so without pings the WSS dies quietly and the phone
        // keeps claiming to be registered while no call can ever reach it.
        keepAliveInterval: options.keepAliveInterval ?? 20,
        keepAliveDebounce: options.keepAliveDebounce ?? 10,
      },
      sessionDescriptionHandlerFactoryOptions: {
        iceGatheringTimeout: options.iceGatheringTimeout ?? 2000,
        peerConnectionConfiguration: {
          iceServers: options.iceServers ?? [],
          // Asterisk does DTLS-SRTP; bundling keeps the SDP simple.
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require',
        },
      },
      userAgentString: options.userAgentString ?? 'AusoPhone/1.0 (SIP.js)',
      logLevel: options.traceSip ? 'debug' : 'warn',
      logConfiguration: false,
      delegate: {
        onConnect: () => this._handleConnect(),
        onDisconnect: (err) => this._handleDisconnect(err),
        onInvite: (invitation) => {
          if (this.onInvite) this.onInvite(invitation);
          else invitation.reject({ statusCode: 480 }).catch(() => {});
        },
      },
    });

    await this.userAgent.start();
    return this.userAgent;
  }

  async disconnect({ permanent = true } = {}) {
    this.reconnect.enabled = !permanent;
    clearTimeout(this.reconnect.timer);
    this.reconnect.timer = null;

    const ua = this.userAgent;
    this.userAgent = null;
    if (!ua) {
      this._setConnectionState(ConnectionState.DISCONNECTED);
      return;
    }
    try {
      await ua.stop();
    } catch (err) {
      log.warn('userAgent.stop() failed', err);
    }
    this._setConnectionState(ConnectionState.DISCONNECTED);
  }

  _handleConnect() {
    const wasReconnecting = this.reconnect.attempts > 0;
    this.reconnect.attempts = 0;
    this._setConnectionState(ConnectionState.CONNECTED);
    if (wasReconnecting && this.onReconnected) this.onReconnected();
  }

  /**
   * Throw the UserAgent away and build a new one.
   *
   * `UserAgent.reconnect()` is only `transport.connect()`, and SIP.js resolves
   * that as a no-op whenever the transport still *believes* it is Connected —
   * it never re-checks the WebSocket. A backgrounded tab lands in exactly that
   * state: the OS reaps the TCP connection, the browser never surfaces a close
   * event, and the transport keeps saying Connected. Every later "reconnect" is
   * then a silent no-op, a REGISTER goes into a dead buffer, and the phone is
   * registered in the UI but deaf at Asterisk. Only a new UserAgent forces a
   * genuinely new socket.
   *
   * Destroys every SIP session on the old UserAgent, so never call this with a
   * call in progress.
   *
   * @param {string} reason for the log line
   * @param {object} [opts]
   * @param {boolean} [opts.notify] call onReconnected on success. Pass false
   *   when the caller intends to re-register itself against the new UserAgent.
   */
  async reconnectFresh(reason = 'requested', { notify = true } = {}) {
    if (!this.credentials) throw new Error('reconnectFresh() before connect()');
    const credentials = this.credentials;
    const options = this._connectOptions;

    this.reconnect.enabled = false;
    clearTimeout(this.reconnect.timer);
    this.reconnect.timer = null;
    this.reconnect.attempts = 0;

    const stale = this.userAgent;
    this.userAgent = null;
    if (stale) {
      try {
        await stale.stop();
      } catch (err) {
        log.warn('userAgent.stop() during rebuild failed', err);
      }
    }
    this._setConnectionState(ConnectionState.DISCONNECTED, { reason, unexpected: true });
    log.info(`rebuilding transport (${reason})`);

    try {
      const userAgent = await this.connect(credentials, options);
      if (notify && this.onReconnected) this.onReconnected();
      return userAgent;
    } finally {
      this.reconnect.enabled = true;
    }
  }

  _handleDisconnect(error) {
    this._setConnectionState(ConnectionState.DISCONNECTED, {
      reason: error ? error.message : 'closed',
      unexpected: Boolean(error),
    });
    if (error && this.reconnect.enabled) this._scheduleReconnect();
  }

  /** Exponential backoff with jitter — a PBX restart shouldn't stampede. */
  _scheduleReconnect() {
    const { attempts, max, baseMs, maxMs } = this.reconnect;
    if (attempts >= max) {
      log.error(`giving up after ${max} reconnect attempts`);
      this.events.emit(PhoneEvents.ERROR, {
        scope: 'transport',
        message: `Could not reconnect to ${this.credentials?.ws_url} after ${max} attempts`,
      });
      return;
    }
    const delay = Math.min(maxMs, baseMs * 2 ** attempts) * (0.7 + Math.random() * 0.6);
    this.reconnect.attempts += 1;
    log.warn(`reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnect.attempts}/${max})`);

    clearTimeout(this.reconnect.timer);
    this.reconnect.timer = setTimeout(async () => {
      if (!this.userAgent) return;
      this._setConnectionState(ConnectionState.CONNECTING, { attempt: this.reconnect.attempts });

      // A transport that still reports Connected is the zombie case: SIP.js
      // resolves UserAgent.reconnect() without opening anything, so the attempt
      // looks like a success and the backoff never re-arms — the phone sits
      // there registered in the UI and deaf at the registrar. Rebuild instead.
      // This branch also covers running out of soft attempts, for the same
      // reason. Genuinely-Disconnected transports take the soft path below,
      // which keeps the same UserAgent (and so the same Registerer) alive.
      const zombie = this.userAgent.isConnected?.() ?? false;
      if (zombie || this.reconnect.attempts >= this.reconnect.freshAfter) {
        try {
          await this.reconnectFresh(zombie ? 'zombie transport' : 'backoff');
        } catch (err) {
          log.warn('transport rebuild attempt failed', err);
          this._scheduleReconnect();
        }
        return;
      }

      try {
        await this.userAgent.reconnect();
      } catch (err) {
        log.warn('reconnect attempt failed', err);
        this._scheduleReconnect();
      }
    }, delay);
  }

  _setConnectionState(state, extra = {}) {
    if (this.connectionState === state && state !== ConnectionState.CONNECTING) return;
    this.connectionState = state;
    const map = {
      [ConnectionState.CONNECTING]: PhoneEvents.CONNECTING,
      [ConnectionState.CONNECTED]: PhoneEvents.CONNECTED,
      [ConnectionState.DISCONNECTED]: PhoneEvents.DISCONNECTED,
    };
    this.events.emit(map[state], { ws_url: this.credentials?.ws_url, ...extra });
  }
}
