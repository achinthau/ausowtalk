/**
 * The complete internal event API (spec §3).
 *
 * These names are the contract between the phone and the CRM. Laravel/Livewire
 * only ever sees these — never SIP.js or WebRTC types.
 */
export const PhoneEvents = Object.freeze({
  // Connection (transport / WSS)
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',

  // Registration
  REGISTERED: 'registered',
  UNREGISTERED: 'unregistered',
  REGISTRATION_FAILED: 'registration_failed',

  // Call lifecycle
  INCOMING: 'incoming',
  DIALING: 'dialing',
  RINGING: 'ringing',
  ANSWERED: 'answered',
  HANGUP: 'hangup',

  // Media
  HOLD: 'hold',
  UNHOLD: 'unhold',
  MUTE: 'mute',
  UNMUTE: 'unmute',

  // Transfer
  TRANSFER_STARTED: 'transfer_started',
  TRANSFER_COMPLETED: 'transfer_completed',
  TRANSFER_FAILED: 'transfer_failed',

  // Extras beyond the spec table, kept namespaced so they can be ignored safely
  DTMF: 'dtmf',
  RECORDING_STARTED: 'recording_started',
  RECORDING_STOPPED: 'recording_stopped',
  RECORDING_UPLOADED: 'recording_uploaded',
  CALL_UPDATED: 'call_updated',
  DEVICES_CHANGED: 'devices_changed',
  ERROR: 'error',
});

/**
 * `transfer` is listed in spec §12 as a subscribable event. We keep it as an
 * umbrella that fires alongside each of the three specific transfer events, so
 * both `AusoPhone.on('transfer', …)` and `AusoPhone.on('transfer_completed', …)`
 * work as documented.
 */
export const TRANSFER_UMBRELLA = 'transfer';

/** Call direction values used in every call payload. */
export const Direction = Object.freeze({
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
});

/** Call state machine. Exposed on every call payload as `state`. */
export const CallState = Object.freeze({
  NEW: 'new',
  DIALING: 'dialing',
  RINGING: 'ringing',
  ANSWERED: 'answered',
  HELD: 'held',
  ENDED: 'ended',
});

/** Registration state, mirrored onto `AusoPhone.state.registration`. */
export const RegistrationState = Object.freeze({
  UNREGISTERED: 'unregistered',
  REGISTERING: 'registering',
  REGISTERED: 'registered',
  FAILED: 'failed',
});

/** Transport state, mirrored onto `AusoPhone.state.connection`. */
export const ConnectionState = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
});

export const ALL_EVENTS = Object.values(PhoneEvents).concat([TRANSFER_UMBRELLA]);
