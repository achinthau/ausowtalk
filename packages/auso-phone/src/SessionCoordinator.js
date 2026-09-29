import { createLogger } from './logger.js';

const log = createLogger('SessionCoordinator');

/**
 * Multi-tab session ownership.
 *
 * A WebRTC call cannot be moved between tabs — the MediaStream and its
 * RTCPeerConnection belong to one browsing context and there is no API to hand
 * either to another. So the best a second tab can do is mirror the live call and
 * forward control to the tab that owns it. That is what this class arranges.
 *
 * Without it every tab runs its own SIP stack against the same extension, and
 * the AOR in pjsip.conf is configured `max_contacts=1` / `remove_existing=yes`,
 * so the newest tab's REGISTER evicts the older one and the older tab is left
 * holding a socket Asterisk no longer routes to.
 *
 * Election is a lease in localStorage: last writer wins, and a writer that still
 * finds its own id there after a short settle delay knows it won. Two tabs
 * claiming in the same instant therefore resolve to exactly one owner, and a tab
 * that dies stops refreshing the lease, so its peers take over once it goes
 * stale.
 */

/** How often the owner refreshes its lease and republishes state. */
const HEARTBEAT_MS = 1000;
/** A lease not refreshed within this is treated as abandoned. */
const STALE_MS = 4000;
/** Delay between writing the lease and re-reading it to confirm the win. */
const SETTLE_MS = 300;
/** How long a companion waits for the owning tab to answer a command. */
const COMMAND_TIMEOUT_MS = 5000;

export const SessionRole = Object.freeze({
  OWNER: 'owner',
  COMPANION: 'companion',
});

/** localStorage is unavailable in some private-mode and embedded contexts. */
function readLease(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
    return typeof parsed?.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeLease(key, id) {
  try {
    localStorage.setItem(key, JSON.stringify({ id, ts: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

function clearLease(key, id) {
  try {
    const current = readLease(key);
    if (!current || current.id === id) localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function newTabId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class SessionCoordinator {
  /**
   * @param {object} options
   * @param {string} options.extension scopes the channel and lease, so two
   *   agents sharing one browser profile never contend for the same owner slot
   * @param {() => object} options.getStatus owner-only: the state to publish
   * @param {(action: string, args: unknown[]) => unknown} options.onCommand
   *   owner-only: run a command relayed by a companion
   * @param {(state: object) => void} [options.onState] companion-only
   * @param {(role: string) => void} [options.onRole] fires on every role change
   */
  constructor({ extension, getStatus, onCommand, onState, onRole }) {
    this.extension = extension ?? null;
    this.getStatus = getStatus;
    this.onCommand = onCommand;
    this.onState = onState ?? (() => {});
    this.onRole = onRole ?? (() => {});

    this.id = newTabId();
    this.role = null;
    this.ownerId = null;
    this.mirrored = null;
    this.peers = new Set();
    /**
     * False when there is nothing to coordinate over. Decided in `join()` rather
     * than here, because the extension only becomes known once the server has
     * answered the credentials request.
     */
    this.enabled = typeof BroadcastChannel === 'function';

    this._name = 'auso-phone';
    this._channel = null;
    this._heartbeat = null;
    this._watchdog = null;
    this._pending = new Map();
    this._cmdSeq = 0;
  }

  get isCompanion() {
    return this.role === SessionRole.COMPANION;
  }

  get isOwner() {
    return this.role === SessionRole.OWNER;
  }

  get leaseKey() {
    return `${this._name}.owner:${this.extension}`;
  }

  /**
   * Join the session and settle on a role. Resolves once the tab knows whether
   * it owns the SIP transport or is mirroring another tab's.
   *
   * @param {string} channelName base name for the channel/lease
   */
  async join(channelName) {
    this._name = channelName;
    this.enabled = this.enabled && Boolean(this.extension);

    if (!this.enabled) {
      // Nothing to coordinate with — this tab is on its own, exactly as it
      // behaved before session support existed.
      this._setRole(SessionRole.OWNER);
      return this.role;
    }

    this._channel = new BroadcastChannel(this.leaseKey);
    this._channel.onmessage = (ev) => this._receive(ev.data);

    // Ask whoever is around to identify itself, so a joining tab has something
    // to show before the first heartbeat lands.
    this._post({ t: 'probe' });

    await this._elect();
    return this.role;
  }

  /** Owner-only. Republish state and refresh the lease. */
  startPublishing() {
    if (!this.enabled || !this.isOwner) return;
    this._stopTimers();
    this._heartbeat = setInterval(() => {
      writeLease(this.leaseKey, this.id);
      this.publish();
    }, HEARTBEAT_MS);
    this.publish();
  }

  stopPublishing() {
    this._stopTimers();
  }

  /** Push the current state out to every companion immediately. */
  publish() {
    if (!this.isOwner) return;
    this._post({ t: 'state', state: this.getStatus() });
  }

  /**
   * Companion-only. Hand a command to the owning tab and wait for its result.
   *
   * @returns {Promise<unknown>} rejects if the owner never answers, so a stale
   *   companion surfaces an error rather than hanging on a promise forever.
   */
  command(action, args = []) {
    if (!this.isCompanion) return Promise.resolve(undefined);

    const id = `${this.id}:${++this._cmdSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('The tab holding this call is not responding.'));
      }, COMMAND_TIMEOUT_MS);

      this._pending.set(id, { resolve, reject, timer });
      this._post({ t: 'cmd', id, action, args });
    });
  }

  /** Leave the session. A call in progress dies with the tab; nothing can move it. */
  leave() {
    if (!this.enabled) return;
    this._post({ t: 'bye' });
    this._stopTimers();

    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error('This tab left the call.'));
    }
    this._pending.clear();

    clearLease(this.leaseKey, this.id);
    try {
      this._channel?.close();
    } catch {
      /* already closed */
    }
    this._channel = null;
  }

  // ---- Election ----------------------------------------------------------

  async _elect() {
    const held = readLease(this.leaseKey);

    // A live lease belongs to a tab that is still publishing. Join it rather
    // than fighting it — the whole point is one registration per extension.
    if (held && held.id !== this.id && Date.now() - (held.ts ?? 0) < STALE_MS) {
      this.ownerId = held.id;
      this._setRole(SessionRole.COMPANION);
      this._startWatchdog();
      return;
    }

    writeLease(this.leaseKey, this.id);
    await sleep(SETTLE_MS);

    const winner = readLease(this.leaseKey);
    if (winner?.id === this.id) {
      this._setRole(SessionRole.OWNER);
      return;
    }

    log.info('lost the lease race — mirroring the tab that won');
    this.ownerId = winner?.id ?? null;
    this._setRole(SessionRole.COMPANION);
    this._startWatchdog();
  }

  /** Companion-only: notice the owner stop publishing, and take over. */
  _startWatchdog() {
    this._stopTimers();
    this._watchdog = setInterval(() => {
      if (this.isOwner) return;
      const held = readLease(this.leaseKey);
      const alive = held && held.id !== this.id && Date.now() - (held.ts ?? 0) < STALE_MS;
      if (alive) return;
      this._promote();
    }, HEARTBEAT_MS);
  }

  /**
   * Take over after the owner goes away. A call that was in progress cannot be
   * recovered — its peer connection died with the tab that owned it — so the
   * caller re-registers and reports the phone as idle.
   */
  _promote() {
    log.warn('the owning tab went away — taking over');
    writeLease(this.leaseKey, this.id);
    this.ownerId = this.id;
    this._stopTimers();
    this._setRole(SessionRole.OWNER);
  }

  // ---- Messaging ---------------------------------------------------------

  _post(message) {
    if (!this._channel) return;
    try {
      this._channel.postMessage({ ...message, from: this.id, ext: this.extension });
    } catch (err) {
      log.warn('could not post to the session channel', err);
    }
  }

  _receive(message) {
    if (!message || message.ext !== this.extension || message.from === this.id) return;
    this.peers.add(message.from);

    switch (message.t) {
      case 'probe':
        // A tab is looking around; tell it who is in charge straight away so it
        // does not render an empty phone for a beat.
        if (this.isOwner) this.publish();
        return;

      case 'state':
        if (this.isOwner) return; // two owners means the lease raced; ignore
        this.ownerId = message.from;
        this.mirrored = message.state;
        this.onState(message.state);
        return;

      case 'cmd':
        if (this.isOwner) this._runCommand(message);
        return;

      case 'cmdResult':
        this._settle(message);
        return;

      case 'bye':
        this.peers.delete(message.from);
        // Only the owner leaving is worth taking over for. A companion closing
        // must not promote its peers into competing registrations.
        if (!this.isOwner && message.from === this.ownerId) this._promote();
        return;

      default:
    }
  }

  _runCommand({ id, action, args }) {
    let result;
    try {
      result = this.onCommand(action, args ?? []);
    } catch (err) {
      this._post({ t: 'cmdResult', id, ok: false, error: err.message });
      return;
    }
    Promise.resolve(result).then(
      (value) => this._post({ t: 'cmdResult', id, ok: true, value }),
      (err) => this._post({ t: 'cmdResult', id, ok: false, error: err?.message ?? String(err) }),
    );
  }

  _settle({ id, ok, value, error }) {
    const entry = this._pending.get(id);
    if (!entry) return;
    this._pending.delete(id);
    clearTimeout(entry.timer);
    if (ok) entry.resolve(value);
    else entry.reject(new Error(error ?? 'The command failed in the other tab.'));
  }

  _stopTimers() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    if (this._watchdog) clearInterval(this._watchdog);
    this._heartbeat = null;
    this._watchdog = null;
  }

  _setRole(role) {
    if (this.role === role) return;
    this.role = role;
    this.onRole(role);
  }
}
