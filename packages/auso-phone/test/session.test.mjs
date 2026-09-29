/**
 * Cross-tab session ownership.
 *
 * The election runs on a localStorage lease plus a BroadcastChannel, so these
 * tests drive the coordinator through fakes of both and assert on the two things
 * that actually matter: exactly one tab owns a given extension, and a companion
 * can see and control the owner's call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionCoordinator, SessionRole } from '../src/SessionCoordinator.js';

/**
 * One in-process "browser": a shared storage area and a set of open channels.
 *
 * Every tab it hands out is tracked, because a leaked heartbeat or watchdog
 * keeps writing into whatever storage the *next* test installs and quietly
 * breaks its election.
 */
function makeBrowser(t) {
  const storage = new Map();
  const channels = new Set();
  const tabs = [];

  class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      this.closed = false;
      channels.add(this);
    }

    postMessage(data) {
      if (this.closed) throw new Error('channel closed');
      // Delivery is asynchronous, like the real thing.
      queueMicrotask(() => {
        for (const peer of channels) {
          if (peer === this || peer.closed || peer.name !== this.name) continue;
          peer.onmessage?.({ data: structuredClone(data) });
        }
      });
    }

    close() {
      this.closed = true;
      channels.delete(this);
    }
  }

  const previous = {
    BroadcastChannel: globalThis.BroadcastChannel,
    localStorage: globalThis.localStorage,
  };

  globalThis.BroadcastChannel = FakeBroadcastChannel;
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  t.after(() => {
    for (const tab of tabs) tab.leave();
    for (const channel of channels) channel.close();
    globalThis.BroadcastChannel = previous.BroadcastChannel;
    globalThis.localStorage = previous.localStorage;
  });

  return {
    storage,
    /** A tab's phone stub, reduced to what the coordinator needs. */
    tab({ extension = '2001', status, onCommand, onState, onRole } = {}) {
      const coordinator = new SessionCoordinator({
        extension,
        getStatus: status ?? (() => ({ calls: [], registered: true })),
        onCommand: onCommand ?? (() => ({})),
        onState,
        onRole,
      });
      tabs.push(coordinator);
      return coordinator;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test('the first tab to claim an extension owns it', async (t) => {
  const browser = makeBrowser(t);
  const tab = browser.tab();

  await tab.join('auso-phone');

  assert.equal(tab.role, SessionRole.OWNER);
  assert.ok(tab.isOwner);
  assert.ok(browser.storage.get(tab.leaseKey).includes(tab.id));
});

test('a second tab mirrors instead of registering', async (t) => {
  const browser = makeBrowser(t);
  const owner = browser.tab();
  await owner.join('auso-phone');
  owner.startPublishing();

  const companion = browser.tab();
  await companion.join('auso-phone');

  assert.equal(owner.role, SessionRole.OWNER);
  assert.equal(companion.role, SessionRole.COMPANION);
  assert.ok(companion.isCompanion);
  // The lease still belongs to the owner, so nobody else registers on top of it.
  assert.ok(browser.storage.get(companion.leaseKey).includes(owner.id));
});

test('a companion mirrors the owner published state', async (t) => {
  const browser = makeBrowser(t);
  let status = { registered: true, calls: [] };
  const seen = [];

  const owner = browser.tab({ status: () => status });
  await owner.join('auso-phone');
  owner.startPublishing();

  const companion = browser.tab({ onState: (state) => seen.push(state) });
  await companion.join('auso-phone');

  status = { registered: true, calls: [{ call_id: 'c1', state: 'answered' }] };
  owner.publish();
  await settle();

  assert.equal(seen.at(-1).calls[0].call_id, 'c1');
  assert.equal(companion.mirrored.calls[0].state, 'answered');
});

test('a joining tab is handed state without waiting for the next heartbeat', async (t) => {
  const browser = makeBrowser(t);
  const owner = browser.tab({ status: () => ({ registered: true, calls: [{ call_id: 'live' }] }) });
  await owner.join('auso-phone');
  // Answer the probe but never heartbeat, so only the probe can be the source.
  owner.startPublishing = () => {};

  const companion = browser.tab();
  await companion.join('auso-phone');
  await settle();

  assert.equal(companion.role, SessionRole.COMPANION);
  assert.equal(companion.mirrored?.calls?.[0]?.call_id, 'live');
});

test('a companion relays commands to the owner and gets the result back', async (t) => {
  const browser = makeBrowser(t);
  const hungUp = [];

  const owner = browser.tab({
    onCommand: (action, args) => {
      hungUp.push([action, args]);
      return 'done';
    },
  });
  await owner.join('auso-phone');
  owner.startPublishing();

  const companion = browser.tab();
  await companion.join('auso-phone');

  assert.equal(await companion.command('hangup', ['c1']), 'done');
  assert.deepEqual(hungUp, [['hangup', ['c1']]]);
});

test('a failing relayed command rejects in the companion', async (t) => {
  const browser = makeBrowser(t);
  const owner = browser.tab({
    onCommand: () => {
      throw new Error('No active call');
    },
  });
  await owner.join('auso-phone');
  owner.startPublishing();

  const companion = browser.tab();
  await companion.join('auso-phone');

  await assert.rejects(() => companion.command('hangup', []), /No active call/);
});

test('a command the owner never answers rejects rather than hanging', async (t) => {
  const browser = makeBrowser(t);
  const owner = browser.tab({ onCommand: () => new Promise(() => {}) });
  await owner.join('auso-phone');
  owner.startPublishing();

  const companion = browser.tab();
  await companion.join('auso-phone');

  await assert.rejects(() => companion.command('hold', []), /not responding/);
});

test('an owner running a command locally is a no-op, not a broadcast', async (t) => {
  const browser = makeBrowser(t);
  const owner = browser.tab();
  await owner.join('auso-phone');
  owner.startPublishing();

  assert.equal(await owner.command('hangup', []), undefined);
});

test('a closed owner hands the session to a companion', async (t) => {
  const browser = makeBrowser(t);
  const owner = browser.tab();
  await owner.join('auso-phone');
  owner.startPublishing();

  const companion = browser.tab();
  await companion.join('auso-phone');
  assert.equal(companion.role, SessionRole.COMPANION);

  owner.leave();
  await settle();

  assert.equal(companion.role, SessionRole.OWNER);
  assert.ok(browser.storage.get(companion.leaseKey).includes(companion.id));
});

test('a companion closing does not promote its peers', async (t) => {
  const browser = makeBrowser(t);
  const owner = browser.tab();
  await owner.join('auso-phone');
  owner.startPublishing();

  const first = browser.tab();
  await first.join('auso-phone');
  const second = browser.tab();
  await second.join('auso-phone');

  assert.equal(first.role, SessionRole.COMPANION);
  assert.equal(second.role, SessionRole.COMPANION);

  first.leave();
  await settle();

  // The owner is still publishing, so neither peer may take over — otherwise
  // the two would end up registering over each other.
  assert.equal(second.role, SessionRole.COMPANION);
  assert.equal(owner.role, SessionRole.OWNER);
});

test('extensions do not contend for the same session', async (t) => {
  const browser = makeBrowser(t);
  const agentOne = browser.tab({ extension: '2001' });
  const agentTwo = browser.tab({ extension: '2002' });

  await agentOne.join('auso-phone');
  await agentTwo.join('auso-phone');

  // Two agents sharing a browser profile each own their own extension.
  assert.equal(agentOne.role, SessionRole.OWNER);
  assert.equal(agentTwo.role, SessionRole.OWNER);
  assert.notEqual(agentOne.leaseKey, agentTwo.leaseKey);
});

test('a tab without an extension coordinates nothing', async (t) => {
  const browser = makeBrowser(t);
  const tab = browser.tab({ extension: null });

  await tab.join('auso-phone');

  assert.equal(tab.enabled, false);
  assert.equal(tab.role, SessionRole.OWNER);
});

test('an abandoned lease is taken over once it goes stale', async (t) => {
  const browser = makeBrowser(t);
  const dead = browser.tab();
  await dead.join('auso-phone');
  dead.startPublishing();

  const companion = browser.tab();
  await companion.join('auso-phone');
  assert.equal(companion.role, SessionRole.COMPANION);

  // Simulate the owning tab being frozen or killed: the lease stops refreshing
  // and nothing announces it.
  clearInterval(dead._heartbeat);
  dead._heartbeat = null;
  browser.storage.set(companion.leaseKey, JSON.stringify({ id: dead.id, ts: Date.now() - 60_000 }));

  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(companion.role, SessionRole.OWNER);
});

test('without BroadcastChannel the tab simply owns the session', async (t) => {
  const browser = makeBrowser(t);
  globalThis.BroadcastChannel = undefined;

  const tab = browser.tab();
  await tab.join('auso-phone');

  assert.equal(tab.enabled, false);
  assert.equal(tab.role, SessionRole.OWNER);
});
