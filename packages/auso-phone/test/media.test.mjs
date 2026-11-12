/**
 * Media edge cases behind the ringback bug.
 *
 * When a carrier answers an outbound INVITE with 183 Session Progress it is
 * already streaming ringback as early media. The phone has to attach that
 * stream as soon as it arrives, and it has to stop its own generated ringback
 * cleanly — including cancelling the gain events it scheduled ahead of time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MediaManager } from '../src/MediaManager.js';

class FakeMediaStream {
  constructor() {
    this.tracks = [];
  }

  addTrack(track) {
    this.tracks.push(track);
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
}

function makeMedia(t) {
  const previousMediaStream = globalThis.MediaStream;
  globalThis.MediaStream = FakeMediaStream;
  t.after(() => {
    globalThis.MediaStream = previousMediaStream;
  });

  const media = new MediaManager();
  media.remoteAudio = {
    srcObject: null,
    volume: 1,
    play: () => Promise.resolve(),
  };
  return media;
}

function makePeerConnection(tracks = [], { remoteDescription = {} } = {}) {
  const listeners = new Map();
  return {
    currentRemoteDescription: remoteDescription,
    getReceivers: () => tracks.map((track) => ({ track })),
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    emitTrack(track) {
      tracks.push(track);
      for (const handler of listeners.get('track') ?? []) handler({ track });
    },
  };
}

test('binds an early-media audio track as soon as it is present', (t) => {
  const media = makeMedia(t);
  const track = { kind: 'audio' };
  const peerConnection = makePeerConnection([track]);
  let attached = 0;

  const bound = media.bindRemoteStream(peerConnection, { onAttach: () => { attached += 1; } });

  assert.equal(bound, true);
  assert.equal(media.remoteAudio.srcObject.getAudioTracks()[0], track);
  assert.equal(attached, 1, 'the caller can drop its local ringback');
});

test('waits for a late early-media track and attaches it once', (t) => {
  const media = makeMedia(t);
  const peerConnection = makePeerConnection();
  let attached = 0;

  const bound = media.bindRemoteStream(peerConnection, { onAttach: () => { attached += 1; } });

  assert.equal(bound, false, 'no track yet, so local ringback should keep playing');
  assert.equal(attached, 0);

  const track = { kind: 'audio' };
  peerConnection.emitTrack(track);

  assert.equal(media.remoteAudio.srcObject.getAudioTracks()[0], track);
  assert.equal(attached, 1, 'attaching early media stops the local ringback');

  // A second track event must not re-run the callback or swap the stream.
  const stream = media.remoteAudio.srcObject;
  peerConnection.emitTrack({ kind: 'audio' });
  assert.equal(media.remoteAudio.srcObject, stream);
  assert.equal(attached, 1);
});

test('unbinding drops a pending early-media listener', (t) => {
  const media = makeMedia(t);
  const peerConnection = makePeerConnection();

  media.bindRemoteStream(peerConnection);
  media.unbindRemoteStream();
  peerConnection.emitTrack({ kind: 'audio' });

  assert.equal(media.remoteAudio.srcObject, null, 'a stale track cannot take over the sink');
});

test('does not bind silent receiver tracks before a remote description', (t) => {
  const media = makeMedia(t);
  const peerConnection = makePeerConnection([{ kind: 'audio' }], { remoteDescription: null });

  const bound = media.bindRemoteStream(peerConnection);

  assert.equal(bound, false, 'a local offer alone is not early media');
  assert.equal(media.remoteAudio.srcObject, null, 'silence is not attached over local ringback');
});

test('does not rebind identical tracks on the confirmed dialog', (t) => {
  const media = makeMedia(t);
  const track = { kind: 'audio' };
  const peerConnection = makePeerConnection([track]);

  media.bindRemoteStream(peerConnection);
  const stream = media.remoteAudio.srcObject;

  media.bindRemoteStream(peerConnection);

  assert.equal(media.remoteAudio.srcObject, stream, 'playout buffer is not reset');
});

test('stopTone cancels scheduled gain events and stops the oscillators', (t) => {
  const media = makeMedia(t);
  const calls = [];
  const timer = setInterval(() => {}, 100_000);
  timer.unref?.();

  media.toneContext = { currentTime: 12.5 };
  media.activeTone = {
    timer,
    master: {
      gain: {
        cancelScheduledValues: (time) => calls.push(['cancel', time]),
        setValueAtTime: (value, time) => calls.push(['set', value, time]),
      },
      disconnect: () => calls.push(['master-disconnect']),
    },
    oscillators: [
      { stop: () => calls.push(['stop']), disconnect: () => calls.push(['disconnect']) },
    ],
  };

  media.stopTone();

  assert.equal(media.activeTone, null);
  assert.deepEqual(calls.slice(0, 2), [['cancel', 12.5], ['set', 0, 12.5]]);
  assert.ok(calls.some(([name]) => name === 'stop'), 'oscillator stopped');
  assert.ok(calls.some(([name]) => name === 'disconnect'), 'oscillator disconnected');
  assert.ok(calls.some(([name]) => name === 'master-disconnect'), 'gain node disconnected');
});

test('stopTone is safe when there is nothing playing', (t) => {
  const media = makeMedia(t);
  assert.doesNotThrow(() => media.stopTone());
  assert.equal(media.activeTone, null);
});
