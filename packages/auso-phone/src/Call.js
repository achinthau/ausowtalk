import { CallState, Direction } from './events.js';

/**
 * A single call leg.
 *
 * Wraps a SIP.js Session but is itself plain data: `toJSON()` is what every
 * event payload carries, so Laravel/Livewire never touches a SIP object.
 */
export class Call {
  /**
   * @param {object} params
   * @param {import('sip.js').Session} params.session
   * @param {'inbound'|'outbound'} params.direction
   * @param {string} params.remoteIdentity  number/extension of the far end
   * @param {string} [params.remoteDisplayName]
   * @param {boolean} [params.consultation] true for the second leg of an attended transfer
   */
  constructor({ session, direction, remoteIdentity, remoteDisplayName, consultation = false }) {
    this.session = session;
    this.direction = direction;
    this.remoteIdentity = remoteIdentity;
    this.remoteDisplayName = remoteDisplayName || '';
    this.consultation = consultation;

    // Prefer the SIP Call-ID so the CRM can correlate with Asterisk CDRs.
    this.id = session?.request?.callId || session?.id || cryptoId();
    this.state = CallState.NEW;
    this.muted = false;
    this.held = false;
    this.recording = false;
    this.createdAt = Date.now();
    this.answeredAt = null;
    this.endedAt = null;
    this.endReason = null;
    /** Populated by the CRM via `phone.attachCustomer(callId, {...})`. */
    this.customer = null;
  }

  get cli() {
    // Spec §5: for an inbound call this is the calling number the CRM looks up.
    return this.remoteIdentity;
  }

  get durationSeconds() {
    if (!this.answeredAt) return 0;
    const end = this.endedAt ?? Date.now();
    return Math.floor((end - this.answeredAt) / 1000);
  }

  get peerConnection() {
    return this.session?.sessionDescriptionHandler?.peerConnection ?? null;
  }

  get isActive() {
    return this.state !== CallState.ENDED;
  }

  /** The exact shape documented in spec §3 and §5, plus useful extras. */
  toJSON() {
    return {
      call_id: this.id,
      direction: this.direction,
      cli: this.cli,
      remote_identity: this.remoteIdentity,
      remote_display_name: this.remoteDisplayName,
      state: this.state,
      muted: this.muted,
      held: this.held,
      recording: this.recording,
      consultation: this.consultation,
      duration: this.durationSeconds,
      created_at: new Date(this.createdAt).toISOString(),
      answered_at: this.answeredAt ? new Date(this.answeredAt).toISOString() : null,
      ended_at: this.endedAt ? new Date(this.endedAt).toISOString() : null,
      end_reason: this.endReason,
      customer: this.customer,
    };
  }
}

/**
 * Extract a dialable number and display name from a SIP.js NameAddrHeader.
 * Asterisk sends anonymous/withheld CLI in a few different shapes; normalise them.
 */
export function parseIdentity(nameAddrHeader) {
  const user = nameAddrHeader?.uri?.user ?? '';
  const displayName = nameAddrHeader?.displayName ?? '';
  const anonymous = !user || /^(anonymous|unknown|restricted)$/i.test(user);
  return {
    number: anonymous ? 'anonymous' : user,
    displayName: displayName && !/^anonymous$/i.test(displayName) ? displayName : '',
  };
}

export { CallState, Direction };

function cryptoId() {
  const bytes = new Uint8Array(8);
  (globalThis.crypto ?? {}).getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
