import { Inviter, SessionState, UserAgent } from 'sip.js';
import { Call, parseIdentity } from './Call.js';
import { createLogger } from './logger.js';
import { CallState, Direction, PhoneEvents } from './events.js';

const log = createLogger('CallManager');

/**
 * Call lifecycle: dial, answer, reject, hangup, hold, mute, DTMF.
 *
 * Every state change is published through EventManager using the names in
 * spec §3, and every payload is `call.toJSON()` so the CRM has the CLI and
 * call_id it needs for the customer lookup in spec §5.
 */
export class CallManager {
  constructor({ events, media, config }) {
    this.events = events;
    this.media = media;
    this.config = config;

    /** @type {Map<string, Call>} */
    this.calls = new Map();
    /** The call the UI is currently focused on. */
    this.activeCallId = null;
    this.autoAnswer = false;
    this.autoAnswerDelayMs = 0;
    /** Guard against answering an inbound call while already on one. */
    this.maxConcurrentCalls = 2; // primary + one consultation leg

    this._durationTimer = null;
  }

  get activeCall() {
    return this.activeCallId ? this.calls.get(this.activeCallId) ?? null : null;
  }

  /** All non-ended calls, most recent first. */
  list() {
    return [...this.calls.values()].filter((c) => c.isActive).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The established, non-consultation call — the customer leg. */
  primaryCall() {
    return this.list().find((c) => !c.consultation && c.state !== CallState.ENDED) ?? null;
  }

  setAutoAnswer(enabled, { delayMs } = {}) {
    this.autoAnswer = Boolean(enabled);
    if (typeof delayMs === 'number') this.autoAnswerDelayMs = delayMs;
    log.info(`auto-answer ${this.autoAnswer ? 'enabled' : 'disabled'}`);
    return this.autoAnswer;
  }

  // ---- Outbound ----------------------------------------------------------

  /**
   * Spec §4: `phone.call(number)`.
   * @param {import('sip.js').UserAgent} userAgent
   * @param {string} number
   * @param {object} [opts]
   * @param {boolean} [opts.consultation] second leg of an attended transfer
   * @param {Record<string,string>} [opts.extraHeaders] e.g. X-Campaign-Id
   */
  async call(userAgent, number, opts = {}) {
    const target = this._makeTarget(userAgent, number);
    if (!target) throw new Error(`Invalid dial target: ${number}`);

    const inviter = new Inviter(userAgent, target, {
      sessionDescriptionHandlerOptions: {
        constraints: this.media.getConstraints(),
      },
      extraHeaders: toExtraHeaders(opts.extraHeaders),
      earlyMedia: true,
    });

    const call = new Call({
      session: inviter,
      direction: Direction.OUTBOUND,
      remoteIdentity: number,
      consultation: Boolean(opts.consultation),
    });
    this._track(call);
    if (!call.consultation) this.activeCallId = call.id;

    this._wireSession(call);
    this._setState(call, CallState.DIALING, PhoneEvents.DIALING);

    await inviter.invite({
      requestDelegate: {
        onProgress: (response) => {
          // 180/183 — the far end is alerting.
          const code = response?.message?.statusCode;
          if (call.state === CallState.DIALING && (code === 180 || code === 183)) {
            this._setState(call, CallState.RINGING, PhoneEvents.RINGING);
            // 183 means Asterisk is sending early media; don't talk over it.
            if (code === 180 && !call.consultation) this.media.startRingback();
          }
        },
        onReject: (response) => {
          const code = response?.message?.statusCode;
          const reason = response?.message?.reasonPhrase || 'Rejected';
          this._end(call, `${code} ${reason}`);
        },
      },
    });

    return call.toJSON();
  }

  // ---- Inbound -----------------------------------------------------------

  /**
   * Called from the UserAgent delegate when Asterisk sends an INVITE.
   * @param {import('sip.js').Invitation} invitation
   */
  handleInvite(invitation) {
    if (this.list().length >= this.maxConcurrentCalls) {
      log.warn('rejecting INVITE — too many concurrent calls');
      invitation.reject({ statusCode: 486 }).catch(() => {});
      return;
    }

    const { number, displayName } = parseIdentity(invitation.remoteIdentity);
    const call = new Call({
      session: invitation,
      direction: Direction.INBOUND,
      remoteIdentity: number,
      remoteDisplayName: displayName,
    });
    this._track(call);
    if (!this.activeCall) this.activeCallId = call.id;

    this._wireSession(call);
    this._setState(call, CallState.RINGING, PhoneEvents.INCOMING, {
      // Any custom headers Asterisk added (campaign, queue, ticket id).
      headers: collectXHeaders(invitation.request),
    });

    // Send 180 Ringing so the caller hears ringback from Asterisk.
    invitation.progress().catch((err) => log.warn('progress() failed', err));

    if (this.autoAnswer) {
      // Spec §6: the CRM checks auto-answer, then the phone answers itself.
      log.info(`auto-answering ${call.id} in ${this.autoAnswerDelayMs}ms`);
      setTimeout(() => {
        if (this.calls.get(call.id)?.state === CallState.RINGING) {
          this.answer(call.id, { auto: true }).catch((err) => log.error('auto-answer failed', err));
        }
      }, this.autoAnswerDelayMs);
    } else {
      this.media.startRingtone();
    }
  }

  /** Spec §4: `phone.answer()`. */
  async answer(callId, { auto = false } = {}) {
    const call = this._require(callId);
    if (call.direction !== Direction.INBOUND) throw new Error('Only inbound calls can be answered');
    if (call.state !== CallState.RINGING) throw new Error(`Call ${call.id} is not ringing`);

    this.media.stopTone();
    // Set this before accept(): the session reaches Established (and
    // _handleEstablished emits `answered`) while accept() is still awaiting, so
    // assigning afterwards would publish auto_answered=false.
    call.autoAnswered = auto;
    await call.session.accept({
      sessionDescriptionHandlerOptions: { constraints: this.media.getConstraints() },
    });
    this.activeCallId = call.id;
    return call.toJSON();
  }

  /** Spec §4: `phone.reject()` — 486 Busy Here. */
  async reject(callId, { statusCode = 486, reason } = {}) {
    const call = this._require(callId);
    this.media.stopTone();
    if (call.direction === Direction.INBOUND && call.state === CallState.RINGING) {
      await call.session.reject({ statusCode, reasonPhrase: reason });
    } else {
      await this.hangup(call.id);
    }
    return call.toJSON();
  }

  /** Spec §4: `phone.hangup()`. Works in every state (CANCEL / BYE / reject). */
  async hangup(callId) {
    const call = this._require(callId);
    const session = call.session;
    this.media.stopTone();

    try {
      switch (session.state) {
        case SessionState.Initial:
        case SessionState.Establishing:
          if (call.direction === Direction.OUTBOUND) await session.cancel();
          else await session.reject({ statusCode: 486 });
          break;
        case SessionState.Established:
          await session.bye();
          break;
        default:
          break; // Terminating/Terminated — nothing to send.
      }
    } catch (err) {
      log.warn(`hangup on ${call.id} failed`, err);
    }
    this._end(call, 'local_hangup');
    return call.toJSON();
  }

  /** Hang up every leg — used on logout. */
  async hangupAll() {
    await Promise.allSettled(this.list().map((c) => this.hangup(c.id)));
  }

  // ---- Hold / mute -------------------------------------------------------

  /**
   * Spec §7: hold is a SIP re-INVITE with sendonly/inactive direction, which is
   * what makes Asterisk play music-on-hold to the customer.
   */
  async hold(callId, held = true) {
    const call = this._require(callId);
    if (call.session.state !== SessionState.Established) {
      throw new Error('Can only hold an established call');
    }
    if (call.held === held) return call.toJSON();

    const sdh = call.session.sessionDescriptionHandler;
    await call.session.invite({
      sessionDescriptionHandlerOptions: { hold: held },
      requestDelegate: {
        onReject: () => {
          log.warn(`re-INVITE for hold=${held} rejected`);
          call.held = !held;
          this.events.emit(PhoneEvents.CALL_UPDATED, { call: call.toJSON() });
        },
      },
    });

    // Belt and braces: stop sending audio while held even if the far end
    // ignores the direction attribute.
    sdh?.enableSenderTracks?.(!held && !call.muted);

    call.held = held;
    call.state = held ? CallState.HELD : CallState.ANSWERED;
    this.events.emit(held ? PhoneEvents.HOLD : PhoneEvents.UNHOLD, { call: call.toJSON() });
    return call.toJSON();
  }

  unhold(callId) {
    return this.hold(callId, false);
  }

  /**
   * Spec §9: microphone off, speaker on. Purely local — no signalling.
   */
  mute(callId, muted = true) {
    const call = this._require(callId);
    this.media.setMuted(call.peerConnection, muted);
    call.muted = muted;
    this.events.emit(muted ? PhoneEvents.MUTE : PhoneEvents.UNMUTE, { call: call.toJSON() });
    return call.toJSON();
  }

  unmute(callId) {
    return this.mute(callId, false);
  }

  // ---- DTMF --------------------------------------------------------------

  /**
   * Spec §4: `phone.sendDTMF("1")`.
   * Prefers RFC 4733 (RTP telephone-event) and falls back to SIP INFO, which is
   * what some Asterisk IVR configurations expect.
   */
  async sendDTMF(callId, tones, { mode = 'auto', duration = 100 } = {}) {
    const call = this._require(callId);
    const clean = String(tones).replace(/[^0-9A-D*#,]/gi, '');
    if (!clean) throw new Error(`Invalid DTMF tones: ${tones}`);

    const sdh = call.session.sessionDescriptionHandler;
    let sent = false;

    if (mode !== 'info' && typeof sdh?.sendDtmf === 'function') {
      sent = sdh.sendDtmf(clean, { duration });
      if (!sent) log.warn('RTP DTMF unavailable, falling back to SIP INFO');
    }

    if (!sent) {
      for (const tone of clean) {
        // eslint-disable-next-line no-await-in-loop
        await call.session.info({
          requestOptions: {
            body: {
              contentDisposition: 'render',
              contentType: 'application/dtmf-relay',
              content: `Signal=${tone}\r\nDuration=${duration}`,
            },
          },
        });
      }
      sent = true;
    }

    this.events.emit(PhoneEvents.DTMF, { call: call.toJSON(), tones: clean, mode: sent ? mode : 'failed' });
    return clean;
  }

  // ---- Internals ---------------------------------------------------------

  _makeTarget(userAgent, number) {
    const raw = String(number).trim();
    if (!raw) return null;
    if (raw.startsWith('sip:') || raw.startsWith('sips:')) return UserAgent.makeURI(raw);
    // Keep + for E.164 and strip formatting the agent may have pasted in.
    const normalised = raw.replace(/[^\d+*#A-Za-z]/g, '');
    return UserAgent.makeURI(`sip:${normalised}@${this.config.sip_domain}`);
  }

  _track(call) {
    this.calls.set(call.id, call);
    this._ensureDurationTimer();
  }

  _require(callId) {
    const id = callId ?? this.activeCallId;
    const call = this.calls.get(id);
    if (!call) throw new Error(`No such call: ${id}`);
    return call;
  }

  _wireSession(call) {
    call.session.stateChange.addListener((state) => {
      log.debug(`call ${call.id} → ${state}`);
      switch (state) {
        case SessionState.Established:
          this._handleEstablished(call);
          break;
        case SessionState.Terminated:
          this._end(call, call.endReason ?? 'remote_hangup');
          break;
        default:
          break;
      }
    });

    call.session.delegate = {
      ...(call.session.delegate ?? {}),
      // Far end put us on hold / took us off hold via re-INVITE.
      onSessionDescriptionHandler: () => {},
      onBye: () => {
        call.endReason = 'remote_hangup';
      },
      onCancel: () => {
        call.endReason = 'caller_cancelled';
      },
      // Asterisk-driven blind transfer of our leg.
      onRefer: (referral) => {
        log.info(`incoming REFER on ${call.id}`);
        referral
          .accept()
          .then(() => referral.makeInviter().invite())
          .catch((err) => log.error('inbound REFER failed', err));
      },
    };
  }

  _handleEstablished(call) {
    this.media.stopTone();
    call.answeredAt = Date.now();
    // Start the 1 Hz tick now that there is something to count. _track() runs
    // before the call is answered, so it can never start the timer itself.
    this._ensureDurationTimer();
    this.media.bindRemoteStream(call.peerConnection);
    // A fresh peer connection resets track.enabled; re-apply mute.
    if (call.muted) this.media.setMuted(call.peerConnection, true);
    this._setState(call, CallState.ANSWERED, PhoneEvents.ANSWERED, {
      auto_answered: Boolean(call.autoAnswered),
    });
  }

  _end(call, reason) {
    if (call.state === CallState.ENDED) return;
    call.state = CallState.ENDED;
    call.endedAt = Date.now();
    call.endReason = call.endReason ?? reason;

    this.media.stopTone();
    if (this.activeCallId === call.id) {
      this.media.unbindRemoteStream();
      // Fall back to a surviving leg (e.g. after an attended transfer consult).
      const next = this.list()[0];
      this.activeCallId = next ? next.id : null;
      if (next) this.media.bindRemoteStream(next.peerConnection);
    }

    this.events.emit(PhoneEvents.HANGUP, { call: call.toJSON(), reason: call.endReason });

    // Keep the record briefly so late UI reads still resolve, then drop it.
    setTimeout(() => this.calls.delete(call.id), 5000);
    this._ensureDurationTimer();
  }

  _setState(call, state, event, extra = {}) {
    call.state = state;
    this.events.emit(event, { call: call.toJSON(), ...extra });
  }

  /** One shared 1s tick that republishes durations for the UI. */
  _ensureDurationTimer() {
    const anyEstablished = this.list().some((c) => c.answeredAt);
    if (anyEstablished && !this._durationTimer) {
      this._durationTimer = setInterval(() => {
        const calls = this.list().filter((c) => c.answeredAt);
        if (!calls.length) return;
        this.events.emit(PhoneEvents.CALL_UPDATED, { calls: calls.map((c) => c.toJSON()) });
      }, 1000);
    } else if (!anyEstablished && this._durationTimer) {
      clearInterval(this._durationTimer);
      this._durationTimer = null;
    }
  }

  destroy() {
    clearInterval(this._durationTimer);
    this._durationTimer = null;
    this.calls.clear();
  }
}

function toExtraHeaders(headers) {
  if (!headers) return undefined;
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
}

function collectXHeaders(request) {
  const out = {};
  const raw = request?.headers ?? {};
  for (const [name, values] of Object.entries(raw)) {
    if (!/^X-/i.test(name)) continue;
    out[name] = Array.isArray(values) ? values.map((v) => v.raw ?? v).join(',') : String(values);
  }
  return out;
}
