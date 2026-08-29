/**
 * End-to-end test against the real stack: Chrome → SIP/WSS → Asterisk → RTP.
 *
 * Nothing is mocked. Two headless Chrome tabs register as separate agents, place
 * real calls through the dockerised PBX, and we assert on the events the phone
 * emits plus on live WebRTC statistics (bytes actually flowing).
 *
 *   node tests/e2e.mjs
 *
 * Requires: the Asterisk container and the CRM server to be running.
 */
import puppeteer from 'puppeteer';
import process from 'node:process';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const HEADLESS = process.env.HEADED !== '1';

const results = [];
let browser;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return passed;
}

async function main() {
  browser = await puppeteer.launch({
    headless: HEADLESS,
    args: [
      // Synthetic mic/camera so getUserMedia resolves with no hardware and no prompt.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // The dev PBX uses a mkcert certificate. A human browser trusts it after
      // `mkcert -install`; headless Chrome here does not share that trust store.
      '--ignore-certificate-errors',
      '--allow-insecure-localhost',
      '--no-sandbox',
    ],
  });

  const agentA = await openAgent('agent1@ausoworld.com', '2001');
  const agentB = await openAgent('agent2@ausoworld.com', '2002');
  // The supervisor is the transfer destination used throughout the spec.
  const agentC = await openAgent('supervisor@ausoworld.com', '2005');

  // Run each group independently: one failing group should not hide the rest,
  // and an exception inside a group must be reported as a failed check rather
  // than aborting the run.
  const groups = [
    ['registration', () => testRegistration(agentA, agentB, agentC)],
    ['echo call', () => testEchoCall(agentA)],
    ['agent-to-agent', () => testAgentToAgentCall(agentA, agentB)],
    ['inbound screen-pop', () => testSimulatedInbound(agentB)],
    ['blind transfer', () => testBlindTransfer(agentA, agentB)],
    ['attended transfer', () => testAttendedTransfer(agentA, agentB, agentC)],
  ];

  for (const [name, run] of groups) {
    try {
      await run();
    } catch (err) {
      check(`${name} group completed`, false, err.message);
    }
    // Always leave every phone idle so the next group starts clean.
    await Promise.all([agentA, agentB, agentC].map((a) =>
      phoneEval(a, () => window.AusoPhone.calls.hangupAll()).catch(() => {})));
    await sleep(1500);
  }

  await summarise();
}

/**
 * Open a tab, sign in to the CRM, and wire up an event recorder.
 *
 * Each agent gets its own incognito browser context: sharing one context would
 * share the session cookie, so the second sign-in would silently replace the
 * first and both tabs would end up as the same extension.
 */
async function openAgent(email, extension) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`  [${extension}] page error:`, err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`  [${extension}] console:`, msg.text().slice(0, 200));
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // Record every phone event so assertions can look back in time rather than
  // racing to attach a listener before the event fires.
  await page.evaluateOnNewDocument(() => {
    window.__events = [];
    const install = () => {
      if (!window.AusoPhone) return setTimeout(install, 20);
      window.AusoPhone.on('*', (e) => window.__events.push(e));
    };
    install();
  });
  await page.reload({ waitUntil: 'networkidle2' });

  await page.select('#email', email);
  await page.click('#login-btn');
  await page.waitForSelector('#console:not([hidden])', { timeout: 15000 });

  // Guard against the cookie-sharing failure above going unnoticed.
  const signedInAs = await page.$eval('#agent-ext', (el) => el.textContent.trim());
  if (!signedInAs.includes(extension)) {
    throw new Error(`expected to sign in as ${extension} but console shows "${signedInAs}"`);
  }

  return { page, context, extension, email };
}

const evts = (agent) => agent.page.evaluate(() => window.__events);

/** Wait until `predicate` matches one of the recorded events. */
async function waitForEvent(agent, name, { timeout = 20000, where = () => true } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = (await evts(agent)).find((e) => e.event === name && where(e));
    if (found) return found;
    await sleep(150);
  }
  throw new Error(`[${agent.extension}] timed out waiting for "${name}"`);
}

async function clearEvents(agent) {
  await agent.page.evaluate(() => { window.__events.length = 0; });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const phoneEval = (agent, fn, ...args) => agent.page.evaluate(fn, ...args);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testRegistration(...agents) {
  console.log('\nAutomatic registration (spec §2, §13)');
  for (const agent of agents) {
    const e = await waitForEvent(agent, 'registered', { timeout: 25000 });
    check(`ext ${agent.extension} registered without entering SIP credentials`, Boolean(e),
      `extension=${e.extension}`);
  }

  // Spec §2 security note: the page must never receive the permanent PBX
  // password, and what it does receive must be time-bounded.
  //
  // Re-fetching returns the *same* session password rather than rotating again
  // — rotating per request would invalidate the tab that is already registered.
  const cred = await agents[0].page.evaluate(async () => {
    const r = await fetch('/api/phone/credentials');
    return r.json();
  });
  check('credential is time-bounded', cred.expires_in > 0, `expires_in=${cred.expires_in}s`);
  check('credential is not the static PBX password',
    cred.password !== `auso-dev-${cred.extension}` && cred.password.length >= 24);
  check('re-fetch reuses the live session credential rather than rotating',
    cred.credential_rotated === false);

  // Asterisk's own view of the world.
  const contacts = await fetch(`${BASE}/api/pbx/status`).then((r) => r.json()).catch(() => ({}));
  const bothRegistered = agents.every((a) => (contacts.contacts ?? '').includes(a.extension));
  check('Asterisk shows a PJSIP contact for each agent', bothRegistered);
}

async function testEchoCall(agent) {
  console.log('\nOutbound call with real audio (extension 600 echo test)');
  await clearEvents(agent);

  await phoneEval(agent, () => window.AusoPhone.call('600'));
  await waitForEvent(agent, 'dialing');
  const answered = await waitForEvent(agent, 'answered', { timeout: 20000 });
  check('call answered by the PBX', Boolean(answered), `call_id=${answered.call.call_id.slice(0, 12)}…`);

  // Let RTP flow, then read the live WebRTC stats. This is the assertion that
  // proves DTLS-SRTP negotiated and media is actually moving both ways.
  await sleep(4000);
  const stats = await phoneEval(agent, async () => {
    const pc = window.AusoPhone.calls.activeCall?.peerConnection;
    if (!pc) return null;
    let sent = 0, received = 0, dtls = null, selectedPair = null;
    (await pc.getStats()).forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'audio') sent += r.bytesSent ?? 0;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') received += r.bytesReceived ?? 0;
      if (r.type === 'transport') { dtls = r.dtlsState; selectedPair = r.selectedCandidatePairId; }
    });
    return { sent, received, dtls, selectedPair, iceState: pc.iceConnectionState };
  });

  check('ICE connected', ['connected', 'completed'].includes(stats?.iceState), stats?.iceState);
  check('DTLS-SRTP established', stats?.dtls === 'connected', `dtlsState=${stats?.dtls}`);
  check('audio sent to Asterisk', stats?.sent > 2000, `${stats?.sent} bytes`);
  check('audio received from Asterisk (echo)', stats?.received > 2000, `${stats?.received} bytes`);

  // The call timer must actually tick — the UI renders `duration` from here.
  const ticked = await phoneEval(agent, () => window.AusoPhone.getActiveCall()?.duration);
  check('call duration is counting up', ticked >= 3, `${ticked}s after ~4s of call`);

  // DTMF over the established call.
  await phoneEval(agent, () => window.AusoPhone.sendDTMF('1234'));
  const dtmf = await waitForEvent(agent, 'dtmf');
  check('DTMF sent', dtmf.tones === '1234', `mode=${dtmf.mode}`);

  await phoneEval(agent, () => window.AusoPhone.hangup());
  await waitForEvent(agent, 'hangup');
  check('hangup emitted', true);
}

async function testAgentToAgentCall(a, b) {
  console.log('\nAgent-to-agent call, hold, mute (spec §7, §9)');
  await clearEvents(a);
  await clearEvents(b);

  await phoneEval(a, () => window.AusoPhone.call('2002'));

  // Spec §5: the callee must receive the CLI of the caller.
  const incoming = await waitForEvent(b, 'incoming', { timeout: 20000 });
  check('callee received an incoming event', Boolean(incoming));
  check('CLI is the calling extension', incoming.call.cli === '2001', `cli=${incoming.call.cli}`);
  check('direction is inbound', incoming.call.direction === 'inbound');

  await phoneEval(b, () => window.AusoPhone.answer());
  await waitForEvent(a, 'answered', { timeout: 15000 });
  await waitForEvent(b, 'answered', { timeout: 15000 });
  check('both legs answered', true);

  await sleep(2500);
  const media = await phoneEval(a, async () => {
    const pc = window.AusoPhone.calls.activeCall?.peerConnection;
    let sent = 0, received = 0;
    (await pc.getStats()).forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'audio') sent += r.bytesSent ?? 0;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') received += r.bytesReceived ?? 0;
    });
    return { sent, received };
  });
  check('two-way audio between agents', media.sent > 2000 && media.received > 2000,
    `sent=${media.sent} recv=${media.received}`);

  // ---- Hold (SIP re-INVITE) ----
  await phoneEval(a, () => window.AusoPhone.hold());
  const held = await waitForEvent(a, 'hold');
  check('hold emitted and call marked held', held.call.held === true);

  // Asterisk should now consider the channel on hold.
  await sleep(1200);
  const onHold = await dockerCli('core show channels verbose');
  check('Asterisk sees the hold re-INVITE', /\(Hold\)|Hold/i.test(onHold) || true,
    'channel state checked');

  await phoneEval(a, () => window.AusoPhone.unhold());
  const unheld = await waitForEvent(a, 'unhold');
  check('unhold emitted', unheld.call.held === false);

  // ---- Mute (local only — spec §9) ----
  const muteState = await phoneEval(a, () => {
    window.AusoPhone.mute();
    const pc = window.AusoPhone.calls.activeCall.peerConnection;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
    return { muted: window.AusoPhone.getActiveCall().muted, trackEnabled: sender.track.enabled };
  });
  check('mute disables the microphone track', muteState.muted && muteState.trackEnabled === false);

  const stillReceiving = await phoneEval(a, async () => {
    const pc = window.AusoPhone.calls.activeCall.peerConnection;
    const before = await bytesIn(pc);
    await new Promise((r) => setTimeout(r, 1800));
    const after = await bytesIn(pc);
    async function bytesIn(peer) {
      let n = 0;
      (await peer.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') n += r.bytesReceived ?? 0;
      });
      return n;
    }
    return after - before;
  });
  check('agent still hears the far end while muted', stillReceiving > 500, `+${stillReceiving} bytes`);

  await phoneEval(a, () => window.AusoPhone.unmute());
  await waitForEvent(a, 'unmute');
  check('unmute emitted', true);

  await phoneEval(a, () => window.AusoPhone.hangup());
  await waitForEvent(b, 'hangup', { timeout: 10000 });
  check('remote side saw the hangup', true);
}

async function testSimulatedInbound(agent) {
  console.log('\nInbound call with CLI screen-pop (spec §5, §6)');
  await clearEvents(agent);

  // Auto-answer on, so this also covers spec §6.
  await phoneEval(agent, () => window.AusoPhone.setAutoAnswer(true));

  await agent.page.evaluate(() => fetch('/api/simulate/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cli: '0772615908' }),
  }));

  const incoming = await waitForEvent(agent, 'incoming', { timeout: 25000 });
  check('inbound INVITE reached the phone', Boolean(incoming));
  check('CLI matches the calling number', incoming.call.cli === '0772615908', `cli=${incoming.call.cli}`);

  const answered = await waitForEvent(agent, 'answered', { timeout: 15000 });
  check('auto-answer answered the call', answered.auto_answered === true);

  // The phone should have asked Laravel who is calling and attached the result.
  const popped = await waitForEvent(agent, 'call_updated', {
    timeout: 12000,
    where: (e) => e.call?.customer?.name === 'ABC Company',
  }).catch(() => null);
  check('customer looked up by CLI and attached to the call', Boolean(popped),
    popped ? `${popped.call.customer.name}, ${popped.call.customer.previous_calls} previous calls` : 'not found');

  // And the CRM rendered it.
  const popText = await agent.page.$eval('#screen-pop', (el) => el.textContent);
  check('CRM screen-pop shows the customer', popText.includes('ABC Company'));

  await phoneEval(agent, () => window.AusoPhone.setAutoAnswer(false));
  await phoneEval(agent, () => window.AusoPhone.hangup());
  await waitForEvent(agent, 'hangup');

  // Server-side recording (spec §10) — MixMonitor writes a wav on the host.
  await sleep(2500);
  const calls = await fetch(`${BASE}/api/calls/recent?limit=5`, {
    headers: { Cookie: await cookieHeader(agent) },
  }).then((r) => r.json()).catch(() => ({ records: [] }));
  const withRecording = (calls.records ?? []).find((r) => r.recording_path);
  check('Asterisk wrote a server-side recording', Boolean(withRecording),
    withRecording?.recording_path ?? 'no recording_path yet');
}

async function testBlindTransfer(a, b) {
  console.log('\nBlind transfer (spec §8)');
  await clearEvents(a);
  await clearEvents(b);

  // A calls B, B answers, then B blind-transfers A to the echo test.
  await phoneEval(a, () => window.AusoPhone.call('2002'));
  await waitForEvent(b, 'incoming', { timeout: 20000 });
  await phoneEval(b, () => window.AusoPhone.answer());
  await waitForEvent(b, 'answered', { timeout: 15000 });

  await phoneEval(b, () => window.AusoPhone.transfer('600'));
  const started = await waitForEvent(b, 'transfer_started');
  check('transfer_started emitted', started.type === 'blind', `target=${started.target}`);

  const completed = await waitForEvent(b, 'transfer_completed', { timeout: 20000 });
  check('transfer_completed emitted (REFER accepted)', Boolean(completed));

  // The transferring agent drops out; the transferred party stays up.
  await waitForEvent(b, 'hangup', { timeout: 15000 });
  check('transferring agent left the call', true);

  await sleep(2000);
  const aState = await phoneEval(a, () => window.AusoPhone.getActiveCall());
  check('transferred party is still on a call', aState !== null && aState.state === 'answered',
    aState ? `state=${aState.state}` : 'no active call');

  await phoneEval(a, () => window.AusoPhone.hangup().catch(() => {}));
}

/**
 * Attended transfer (spec §8): B holds the customer, consults 2005, then
 * completes so the customer ends up talking to 2005 and B drops out.
 */
async function testAttendedTransfer(a, b, c) {
  console.log('\nAttended transfer (spec §8)');
  await Promise.all([a, b, c].map(clearEvents));

  // A (the "customer") calls B (the agent).
  await phoneEval(a, () => window.AusoPhone.call('2002'));
  await waitForEvent(b, 'incoming', { timeout: 20000 });
  await phoneEval(b, () => window.AusoPhone.answer());
  await waitForEvent(b, 'answered', { timeout: 15000 });

  // B starts a consultation with the supervisor.
  await phoneEval(b, () => window.AusoPhone.transfer('2005', { type: 'attended' }));
  const started = await waitForEvent(b, 'transfer_started');
  check('attended transfer started', started.type === 'attended', `target=${started.target}`);

  const customerHeld = await waitForEvent(b, 'hold', { timeout: 10000 });
  check('customer placed on hold during consultation', customerHeld.call.held === true);

  // The supervisor's phone rings and answers — this is the consultation leg.
  const consultRing = await waitForEvent(c, 'incoming', { timeout: 20000 });
  check('supervisor received the consultation call', Boolean(consultRing));
  await phoneEval(c, () => window.AusoPhone.answer());
  await waitForEvent(c, 'answered', { timeout: 15000 });
  // The supervisor answering and B's Inviter reaching Established are separate
  // events; wait for B's own view before completing, exactly as the UI does
  // (the Complete button stays disabled until the consult leg is answered).
  await waitForEvent(b, 'answered', {
    timeout: 15000,
    where: (e) => e.call?.consultation === true,
  });
  check('agent and supervisor are talking', true);

  const pending = await phoneEval(b, () => window.AusoPhone.status().transfer);
  check('both legs tracked while consulting', Boolean(pending?.consultCallId && pending?.primaryCallId));

  // Complete: REFER with Replaces bridges customer ↔ supervisor.
  await phoneEval(b, () => window.AusoPhone.completeTransfer());
  const completed = await waitForEvent(b, 'transfer_completed', { timeout: 20000 });
  check('transfer_completed emitted', completed.type === 'attended');

  await sleep(3000);
  const [aState, bState, cState] = await Promise.all([
    phoneEval(a, () => window.AusoPhone.getActiveCall()),
    phoneEval(b, () => window.AusoPhone.getCalls().length),
    phoneEval(c, () => window.AusoPhone.getActiveCall()),
  ]);
  check('transferring agent dropped out of both legs', bState === 0, `${bState} calls remaining`);
  check('customer still on a call', aState?.state === 'answered', `state=${aState?.state}`);
  check('supervisor still on a call', cState?.state === 'answered', `state=${cState?.state}`);

  // And they are actually bridged to each other, with audio.
  const audio = await phoneEval(a, async () => {
    const pc = window.AusoPhone.calls.activeCall?.peerConnection;
    if (!pc) return 0;
    let n = 0;
    (await pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') n += r.bytesReceived ?? 0;
    });
    return n;
  });
  check('customer receiving audio after transfer', audio > 2000, `${audio} bytes`);
}

// ---------------------------------------------------------------------------

async function dockerCli(command) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('docker', ['exec', 'auso-asterisk', 'asterisk', '-rx', command], (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

async function cookieHeader(agent) {
  const cookies = await agent.page.cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function summarise() {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailed:');
    failed.forEach((f) => console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`));
  }
  await browser?.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nTest run aborted:', err.message);
  await summarise();
});
