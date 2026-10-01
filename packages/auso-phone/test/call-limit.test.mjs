/**
 * One call per extension.
 *
 * The rule the phone has to hold: an extension is never on two customer calls
 * at once. A second simultaneous INVITE is answered with 486 Busy Here so the
 * caller hears engaged rather than silence, and a second outbound dial is
 * refused in the browser rather than sent to the PBX.
 *
 * The one deliberate exception is the consultation leg of an attended
 * transfer, which is *meant* to be a second leg while the customer is held —
 * so these tests pin that exception down as firmly as the restriction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionState } from 'sip.js';

import { CallManager } from '../src/CallManager.js';
import { CallState, Direction } from '../src/events.js';

/** Collects the events CallManager publishes, so tests can assert on them. */
function makeEvents() {
  const emitted = [];
  return {
    emitted,
    emit(event, payload) { emitted.push({ event, payload }); },
    on() { return () => {}; },
    off() {},
    once() { return () => {}; },
  };
}

function makeMedia() {
  return {
    startRingtone() {}, stopTone() {}, startRingback() {},
    bindRemoteStream() {}, unbindRemoteStream() {}, setMuted() {},
    getConstraints: () => ({}),
  };
}

function makeManager(t) {
  const events = makeEvents();
  const manager = new CallManager({
    events,
    media: makeMedia(),
    config: { sip_domain: 'pbx.test' },
  });
  // `_ensureDurationTimer` starts a shared 1 Hz interval as soon as any call has
  // been answered, and it outlives the test that created it — which leaves the
  // runner waiting on a handle that will never close.
  t.after(() => manager.destroy());
  return { manager, events };
}

/**
 * An Invitation shaped like the parts of sip.js's Invitation CallManager touches.
 * Everything is recorded so a test can assert on what was sent to the caller.
 */
function makeInvitation(callId, cli = '0771111111') {
  const sent = { reject: null, progress: 0 };
  return {
    sent,
    id: callId,
    request: { callId },
    remoteIdentity: { uri: { user: cli }, displayName: '' },
    state: SessionState.Initial,
    get stateChange() {
      return { addListener() {} };
    },
    delegate: {},
    reject(options) { sent.reject = options; return Promise.resolve(); },
    progress() { sent.progress += 1; return Promise.resolve(); },
    bye() { return Promise.resolve(); },
    info() { return Promise.resolve(); },
  };
}

/** An already-tracked call in a given state, for setting up the "busy" case. */
function seed(manager, { state = CallState.ANSWERED, consultation = false, sessionState = SessionState.Established } = {}) {
  const id = `seed-${manager.calls.size}-${Math.random().toString(36).slice(2, 8)}`;
  const session = { state: sessionState, id };
  manager.calls.set(id, {
    id,
    session,
    direction: Direction.OUTBOUND,
    remoteIdentity: '0772222222',
    consultation,
    state,
    muted: false,
    held: false,
    recording: false,
    customer: null,
    createdAt: Date.now(),
    answeredAt: state === CallState.ANSWERED ? Date.now() : null,
    endedAt: state === CallState.ENDED ? Date.now() : null,
    endReason: null,
    get isActive() { return this.state !== CallState.ENDED; },
    toJSON() { return { call_id: this.id, state: this.state, consultation: this.consultation }; },
  });
  return id;
}

test('defaults to one concurrent call per extension', (t) => {
  const { manager } = makeManager(t);
  assert.equal(manager.maxConcurrentCalls, 1);
});

test('accepts the first inbound call', (t) => {
  const { manager, events } = makeManager(t);
  const invitation = makeInvitation('call-1');
  manager.handleInvite(invitation);

  assert.equal(invitation.sent.reject, null, 'was not rejected');
  assert.equal(invitation.sent.progress, 1, 'answered with 180 Ringing');
  assert.equal(manager.list().length, 1);
  assert.ok(events.emitted.some((e) => e.event === 'incoming'), 'published `incoming`');
});

test('rejects a second simultaneous inbound call with 486', (t) => {
  const { manager, events } = makeManager(t);
  manager.handleInvite(makeInvitation('call-1'));

  const second = makeInvitation('call-2');
  manager.handleInvite(second);

  assert.equal(second.sent.reject?.statusCode, 486, 'caller told the extension is busy');
  assert.match(second.sent.reject?.reasonPhrase ?? '', /busy/i);
  assert.equal(manager.list().length, 1, 'no second call reached the phone');
  assert.equal(events.emitted.filter((e) => e.event === 'incoming').length, 1,
    'no second `incoming` event, so nothing to answer');
});

test('rejects a second inbound call while the first is still ringing', (t) => {
  // Not just while established: a ringing call already holds the extension, and
  // this is the case that produces two incoming cards at once.
  const { manager } = makeManager(t);
  manager.handleInvite(makeInvitation('call-1'));

  const second = makeInvitation('call-2');
  manager.handleInvite(second);

  assert.equal(second.sent.reject?.statusCode, 486);
  assert.equal(manager.list().length, 1);
});

test('rejects a second inbound call while the first is on hold', (t) => {
  const { manager } = makeManager(t);
  seed(manager, { state: CallState.HELD, sessionState: SessionState.Established });

  const invitation = makeInvitation('call-2');
  manager.handleInvite(invitation);

  assert.equal(invitation.sent.reject?.statusCode, 486);
  assert.equal(manager.list().length, 1);
});

test('accepts an inbound call again once the previous one has ended', (t) => {
  const { manager } = makeManager(t);
  const first = makeInvitation('call-1');
  manager.handleInvite(first);

  // Hang up: the logical call ends immediately, the dialog takes a moment to
  // reach Terminated, which is exactly the window the next test covers.
  const call = manager.calls.get('call-1');
  call.state = CallState.ENDED;
  call.session.state = SessionState.Terminated;

  const next = makeInvitation('call-2');
  manager.handleInvite(next);

  assert.equal(next.sent.reject, null, 'the extension is free again');
});

test('rejects a second inbound call while the previous dialog is still tearing down', (t) => {
  // `hangup()` ends the call logically before the BYE completes. The AOR is still
  // carrying that dialog, so accepting an INVITE on top of it is the overlap
  // this rule exists to prevent.
  const { manager } = makeManager(t);
  seed(manager, { state: CallState.ENDED, sessionState: SessionState.Terminating });

  const invitation = makeInvitation('call-2');
  manager.handleInvite(invitation);

  assert.equal(invitation.sent.reject?.statusCode, 486);
  assert.equal(manager.list().length, 0, 'the ended call is not offered as a live call');
});

test('refuses a second outbound dial while already on a call', async (t) => {
  const { manager } = makeManager(t);
  seed(manager);

  await assert.rejects(
    () => manager.call({}, '0773333333'),
    /already on a call/i,
  );
  assert.equal(manager.list().length, 1, 'no INVITE was sent to the PBX');
});

test('refuses an outbound dial while the extension is busy ringing', async (t) => {
  const { manager } = makeManager(t);
  manager.handleInvite(makeInvitation('call-1'));

  await assert.rejects(() => manager.call({}, '0773333333'), /already on a call/i);
});

test('allows a second outbound dial once the first call has ended', async (t) => {
  const { manager } = makeManager(t);
  seed(manager, { state: CallState.ENDED, sessionState: SessionState.Terminated });

  assert.equal(manager._isExtensionBusy(), false, 'the extension is free');

  // An empty number makes `call()` fail on `_makeTarget`, the very next step
  // after the guard — so this proves the guard let the dial through without
  // involving the SIP stack.
  await assert.rejects(() => manager.call({}, ''), /invalid dial target/i);
});

// ---- The attended-transfer exception -------------------------------------

test('allows the consultation leg of an attended transfer', async (t) => {
  // An attended transfer is the one time the agent is meant to be on two legs:
  // the customer is on hold and the third party is being announced. Blocking
  // this would break attended transfers outright.
  const { manager } = makeManager(t);
  seed(manager, { state: CallState.HELD, sessionState: SessionState.Established });

  // Busy for a normal dial...
  assert.equal(manager._isExtensionBusy(), true);
  await assert.rejects(() => manager.call({}, '0773333333'), /already on a call/i);

  // ...but a consultation leg is allowed alongside the customer call it belongs
  // to, so it gets past the guard and fails later on the empty number instead.
  assert.equal(manager._isExtensionBusy({ addingConsultation: true }), false);
  await assert.rejects(
    () => manager.call({}, '', { consultation: true }),
    /invalid dial target/i,
    'the consultation leg is not blocked by the customer call',
  );
});

test('rejects an inbound call while a consultation is up', (t) => {
  // The consultation still occupies the extension, so a third party dialling in
  // gets engaged rather than landing on an agent mid-announcement.
  const { manager } = makeManager(t);
  seed(manager, { state: CallState.HELD, sessionState: SessionState.Established });
  seed(manager, { state: CallState.ANSWERED, consultation: true, sessionState: SessionState.Established });

  const invitation = makeInvitation('call-inbound');
  manager.handleInvite(invitation);

  assert.equal(invitation.sent.reject?.statusCode, 486);
});

test('honours a raised limit when a deployment configures one', (t) => {
  const { manager } = makeManager(t);
  manager.setMaxConcurrentCalls(2);
  seed(manager);

  const second = makeInvitation('call-2');
  manager.handleInvite(second);

  assert.equal(second.sent.reject, null, 'a second call is allowed at limit 2');
  assert.equal(manager.list().length, 2);
});

test('never lets the limit drop below one', (t) => {
  const { manager } = makeManager(t);
  assert.equal(manager.setMaxConcurrentCalls(0), 1);
  assert.equal(manager.setMaxConcurrentCalls('nonsense'), 1);
  assert.equal(manager.setMaxConcurrentCalls(-5), 1);
});
