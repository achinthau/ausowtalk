import { SessionState, UserAgent } from 'sip.js';
import { createLogger } from './logger.js';
import { CallState, PhoneEvents, TRANSFER_UMBRELLA } from './events.js';

const log = createLogger('TransferManager');

/**
 * Blind and attended transfer (spec §8).
 *
 * Blind    — one REFER to the target; we drop out immediately.
 * Attended — hold the customer, dial the target, talk, then REFER with
 *            Replaces so Asterisk bridges customer↔target and drops us.
 *
 * The attended flow is a small state machine because the agent can bail out at
 * any point (`cancelAttended`), and because the consultation leg can be
 * rejected while the customer is still sitting on hold.
 */
export class TransferManager {
  constructor({ events, calls, media, config }) {
    this.events = events;
    this.calls = calls;
    this.media = media;
    this.config = config;

    /**
     * @type {null | {
     *   type: 'attended',
     *   stage: 'consulting'|'ringing'|'connected',
     *   primaryCallId: string,
     *   consultCallId: string|null,
     *   target: string,
     * }}
     */
    this.pending = null;
  }

  get inProgress() {
    return this.pending !== null;
  }

  // ---- Blind -------------------------------------------------------------

  /**
   * Spec §4/§12: `phone.transfer(number)` defaults to blind.
   * @param {import('sip.js').UserAgent} userAgent
   * @param {string} target extension or number
   * @param {string} [callId] defaults to the primary (customer) call
   */
  async blindTransfer(userAgent, target, callId) {
    const call = this._requireEstablished(callId);
    const uri = this._makeTarget(userAgent, target);
    if (!uri) throw new Error(`Invalid transfer target: ${target}`);

    this._emit(PhoneEvents.TRANSFER_STARTED, { type: 'blind', target, call: call.toJSON() });

    return new Promise((resolve, reject) => {
      call.session
        .refer(uri, {
          // The PBX reports the outcome of the transfer through NOTIFY
          // (RFC 3515 sipfrag), not in the 202 to the REFER.
          onNotify: (notification) => {
            const status = parseSipfrag(notification?.request?.body);
            log.debug(`blind transfer NOTIFY: ${status ?? 'unparsed'}`);
            notification.accept?.().catch(() => {});
            if (status && status >= 200 && status < 300) {
              this._finishBlind(call, target, resolve);
            } else if (status && status >= 300) {
              this._emit(PhoneEvents.TRANSFER_FAILED, {
                type: 'blind', target, code: status, reason: 'Transfer target rejected',
                call: call.toJSON(),
              });
            }
          },
          requestDelegate: {
            onAccept: () => {
              log.info(`blind transfer to ${target} accepted (202)`);
              this._emit(PhoneEvents.TRANSFER_COMPLETED, {
                type: 'blind',
                target,
                call: call.toJSON(),
              });
              // Do NOT hang up here. A 202 only means the REFER was accepted;
              // Asterisk still has to build the new bridge. Sending BYE now can
              // race that and tear down the transferred party's call too.
              // Asterisk sends us a BYE when it is done — this timer is only a
              // fallback for a PBX that doesn't.
              this._blindFallback = setTimeout(() => {
                if (this.calls.calls.get(call.id)?.isActive) {
                  log.warn('PBX did not hang up our leg after the transfer; doing it locally');
                  this.calls.hangup(call.id).catch(() => {});
                }
              }, 8000);
              resolve({ type: 'blind', target, status: 'accepted' });
            },
            onReject: (response) => {
              const code = response?.message?.statusCode;
              const reason = response?.message?.reasonPhrase || 'REFER rejected';
              log.error(`blind transfer rejected ${code} ${reason}`);
              this._emit(PhoneEvents.TRANSFER_FAILED, {
                type: 'blind',
                target,
                code,
                reason,
                call: call.toJSON(),
              });
              reject(new Error(`Transfer failed: ${code} ${reason}`));
            },
          },
        })
        .catch((err) => {
          this._emit(PhoneEvents.TRANSFER_FAILED, { type: 'blind', target, reason: err.message });
          reject(err);
        });
    });
  }

  /** The far end confirmed the transfer connected; our leg can go. */
  _finishBlind(call, target, resolve) {
    clearTimeout(this._blindFallback);
    this._blindFallback = null;
    if (this.calls.calls.get(call.id)?.isActive) {
      this.calls.hangup(call.id).catch(() => {});
    }
    resolve?.({ type: 'blind', target, status: 'completed' });
  }

  // ---- Attended ----------------------------------------------------------

  /**
   * Step 1: put the customer on hold and call the target so the agent can
   * announce the call. Resolves when the consultation leg has been created —
   * the agent then waits for `answered` on the consultation call.
   */
  async startAttended(userAgent, target, callId) {
    if (this.pending) throw new Error('A transfer is already in progress');
    const call = this._requireEstablished(callId);

    this.pending = {
      type: 'attended',
      stage: 'consulting',
      primaryCallId: call.id,
      consultCallId: null,
      target,
    };
    this._emit(PhoneEvents.TRANSFER_STARTED, { type: 'attended', target, call: call.toJSON() });

    try {
      // Spec §8: "Hold Customer" then "Call Agent 2005".
      if (!call.held) await this.calls.hold(call.id, true);
      const consult = await this.calls.call(userAgent, target, { consultation: true });
      this.pending.consultCallId = consult.call_id;
      this.pending.stage = 'ringing';
      return { ...this.pending, consultation: consult };
    } catch (err) {
      await this._abort(`Consultation call failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Step 2: the agent has spoken to the target and clicks "Complete Transfer".
   * Sends REFER with Replaces on the customer leg pointing at the consultation
   * dialog, which is what makes this an attended (not blind) transfer.
   */
  async completeAttended() {
    if (!this.pending || this.pending.type !== 'attended') {
      throw new Error('No attended transfer in progress');
    }
    const { primaryCallId, consultCallId, target } = this.pending;
    const primary = this.calls.calls.get(primaryCallId);
    const consult = this.calls.calls.get(consultCallId);

    if (!primary || primary.state === CallState.ENDED) {
      await this._abort('Customer hung up before the transfer completed');
      throw new Error('Customer call is gone');
    }
    if (!consult || consult.session.state !== SessionState.Established) {
      await this._abort('Consultation call is not established');
      throw new Error('Consultation call is not established');
    }

    return new Promise((resolve, reject) => {
      primary.session
        .refer(consult.session, {
          requestDelegate: {
            onAccept: () => {
              log.info(`attended transfer to ${target} accepted`);
              this._emit(PhoneEvents.TRANSFER_COMPLETED, {
                type: 'attended',
                target,
                call: primary.toJSON(),
              });
              this.pending = null;
              // Safe to drop both legs immediately, unlike a blind transfer.
              // REFER-with-Replaces makes the swap atomic: by the time the PBX
              // accepts, the customer↔target dialog has already replaced our
              // consultation leg, so neither of ours is holding the bridge up.
              // The agent expects to be free the instant they hit Complete.
              Promise.allSettled([
                this.calls.hangup(consult.id),
                this.calls.hangup(primary.id),
              ]).then(() => resolve({ type: 'attended', target, status: 'accepted' }));
            },
            onReject: (response) => {
              const code = response?.message?.statusCode;
              const reason = response?.message?.reasonPhrase || 'REFER rejected';
              this._emit(PhoneEvents.TRANSFER_FAILED, {
                type: 'attended',
                target,
                code,
                reason,
                call: primary.toJSON(),
              });
              this.pending = null;
              reject(new Error(`Transfer failed: ${code} ${reason}`));
            },
          },
        })
        .catch((err) => {
          this._emit(PhoneEvents.TRANSFER_FAILED, { type: 'attended', target, reason: err.message });
          this.pending = null;
          reject(err);
        });
    });
  }

  /**
   * Bail out: drop the consultation leg and take the customer off hold.
   * Safe to call at any stage.
   */
  async cancelAttended() {
    if (!this.pending) return null;
    const { primaryCallId, consultCallId, target } = this.pending;
    this.pending = null;

    if (consultCallId && this.calls.calls.has(consultCallId)) {
      await this.calls.hangup(consultCallId).catch(() => {});
    }
    const primary = this.calls.calls.get(primaryCallId);
    if (primary && primary.isActive && primary.held) {
      await this.calls.unhold(primary.id).catch((err) => log.warn('unhold after cancel failed', err));
    }
    this._emit(PhoneEvents.TRANSFER_FAILED, {
      type: 'attended',
      target,
      reason: 'cancelled_by_agent',
      cancelled: true,
    });
    return { cancelled: true };
  }

  /** Swap which leg the agent is talking to during a consultation. */
  async toggleConsultation() {
    if (!this.pending?.consultCallId) throw new Error('No consultation call');
    const primary = this.calls.calls.get(this.pending.primaryCallId);
    const consult = this.calls.calls.get(this.pending.consultCallId);
    if (!primary || !consult) throw new Error('Transfer legs are no longer available');

    if (primary.held) {
      await this.calls.hold(consult.id, true);
      await this.calls.unhold(primary.id);
      this.calls.activeCallId = primary.id;
    } else {
      await this.calls.hold(primary.id, true);
      await this.calls.unhold(consult.id);
      this.calls.activeCallId = consult.id;
    }
    this.media.bindRemoteStream(this.calls.activeCall?.peerConnection);
    return this.calls.activeCall?.toJSON() ?? null;
  }

  /** Called by AusoPhone when a leg involved in a pending transfer dies. */
  notifyCallEnded(callId) {
    if (!this.pending) return;
    if (callId === this.pending.consultCallId && this.pending.stage !== 'completed') {
      log.warn('consultation leg ended — reverting customer off hold');
      this.cancelAttended().catch(() => {});
    } else if (callId === this.pending.primaryCallId) {
      log.warn('customer leg ended during transfer');
      const { consultCallId } = this.pending;
      this.pending = null;
      if (consultCallId) this.calls.hangup(consultCallId).catch(() => {});
    }
  }

  async _abort(reason) {
    const target = this.pending?.target;
    const primaryCallId = this.pending?.primaryCallId;
    this.pending = null;
    const primary = primaryCallId ? this.calls.calls.get(primaryCallId) : null;
    if (primary?.isActive && primary.held) await this.calls.unhold(primary.id).catch(() => {});
    this._emit(PhoneEvents.TRANSFER_FAILED, { type: 'attended', target, reason });
  }

  _requireEstablished(callId) {
    const call = callId ? this.calls.calls.get(callId) : this.calls.primaryCall();
    if (!call) throw new Error('No call to transfer');
    if (call.session.state !== SessionState.Established) {
      throw new Error('Can only transfer an established call');
    }
    return call;
  }

  _makeTarget(userAgent, target) {
    const raw = String(target).trim();
    if (raw.startsWith('sip:') || raw.startsWith('sips:')) return UserAgent.makeURI(raw);
    return UserAgent.makeURI(`sip:${raw.replace(/[^\d+*#A-Za-z]/g, '')}@${this.config.sip_domain}`);
  }

  /** Fire the specific event plus the `transfer` umbrella from spec §12. */
  _emit(event, payload) {
    this.events.emit(event, payload);
    this.events.emit(TRANSFER_UMBRELLA, { stage: event, ...payload });
  }
}

/**
 * RFC 3515: a REFER's progress is reported by NOTIFY bodies of type
 * message/sipfrag, whose first line is a status line, e.g. "SIP/2.0 200 OK".
 */
function parseSipfrag(body) {
  const match = /^SIP\/2\.0\s+(\d{3})/m.exec(String(body ?? ''));
  return match ? Number(match[1]) : null;
}
