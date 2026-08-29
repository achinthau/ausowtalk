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

    this.reconnect = { attempts: 0, timer: null, max: 10, baseMs: 1000, maxMs: 30000, enabled: true };
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
   */
  async connect(credentials, options = {}) {
    if (this.userAgent) await this.disconnect();
    this.credentials = credentials;

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
