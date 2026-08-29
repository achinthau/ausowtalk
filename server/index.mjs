#!/usr/bin/env node
/**
 * Mock "Auso Call Hub" CRM backend.
 *
 * Stands in for Laravel so the whole stack runs on a Mac with no PHP. Every
 * endpoint here has a real Laravel counterpart in ../laravel/, and the URLs and
 * JSON shapes are identical — so the browser phone cannot tell the difference.
 *
 *   POST /api/login                 agent authentication (spec §2, §13)
 *   GET  /api/phone/credentials     short-lived SIP credentials (spec §2)
 *   GET  /api/customers/lookup      CLI → customer screen-pop (spec §5)
 *   POST /api/phone/call-records    browser-reported CDR (spec §10)
 *   POST /api/phone/recordings      optional browser recording upload (spec §10)
 *   GET  /api/asterisk/cdr          server-side CDR pushed by the dialplan
 *   POST /api/simulate/inbound      originate a fake customer call over AMI
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AmiClient } from './ami.mjs';
import { SipProvisioner } from './sip-provisioner.mjs';
import { Store, normalisePhone } from './store.mjs';
import {
  RateLimiter, Router, SessionStore,
  json, parseMultipart, readBody, readJson, serveStatic, text,
} from './http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const config = {
  port: Number(process.env.PORT ?? 8080),
  // Must not be loopback-only: the Asterisk container posts its CDRs to
  // host.docker.internal, which arrives on the Docker bridge interface, not on
  // 127.0.0.1. The one unauthenticated endpoint (/api/asterisk/cdr) is guarded
  // by cdrToken below.
  host: process.env.HOST ?? '0.0.0.0',
  // Shared secret for the dialplan → CRM callback. Must match CDR_TOKEN in
  // asterisk/etc/extensions.conf.
  cdrToken: process.env.CDR_TOKEN ?? 'auso-dev-cdr-token',
  // What the browser is told to connect to. Override to point at a real PBX.
  sipDomain: process.env.SIP_DOMAIN ?? 'localhost',
  wsUrl: process.env.SIP_WS_URL ?? 'wss://localhost:8089/ws',
  extensions: (process.env.SIP_EXTENSIONS ?? '2001,2002,2003,2004,2005').split(','),
  credentialTtl: Number(process.env.SIP_CREDENTIAL_TTL ?? 3600),
  // Set to 0 to hand out the static passwords in dynamic/pjsip_auth.conf instead
  // of rotating them (useful when pointing at a PBX you don't control).
  rotateCredentials: process.env.SIP_ROTATE !== '0',
  ami: {
    host: process.env.AMI_HOST ?? '127.0.0.1',
    port: Number(process.env.AMI_PORT ?? 5038),
    username: process.env.AMI_USER ?? 'auso',
    secret: process.env.AMI_SECRET ?? 'auso-dev-ami',
  },
  authFile: process.env.SIP_AUTH_FILE ?? path.join(ROOT, 'asterisk', 'dynamic', 'pjsip_auth.conf'),
  serverRecordings: path.join(ROOT, 'asterisk', 'recordings'),
  browserRecordings: path.join(ROOT, 'server', 'uploads'),
  dataFile: process.env.DATA_FILE ?? path.join(ROOT, 'server', 'data', 'db.json'),
};

const store = new Store(config.dataFile);
const sessions = new SessionStore();
const loginLimiter = new RateLimiter({ windowMs: 60_000, max: 20 });
const credentialLimiter = new RateLimiter({ windowMs: 60_000, max: 60 });

const ami = new AmiClient(config.ami);
const provisioner = new SipProvisioner({
  authFile: config.authFile,
  ami,
  extensions: config.extensions,
  ttlSeconds: config.credentialTtl,
  rotate: config.rotateCredentials,
});

fs.mkdirSync(config.browserRecordings, { recursive: true });

/** Live SSE listeners, so the console can show Asterisk events as they happen. */
const eventStreams = new Set();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const router = new Router();

router.get('/api/health', (req, res) => json(res, 200, {
  ok: true,
  ami: ami.connected,
  sip_domain: config.sipDomain,
  ws_url: config.wsUrl,
  rotate_credentials: config.rotateCredentials,
}));

router.get('/api/branding', (req, res) => json(res, 200, store.branding));

// ---- Authentication (stands in for Laravel's auth guard) ------------------

router.post('/api/login', async (req, res) => {
  if (!loginLimiter.check(clientKey(req))) return json(res, 429, { message: 'Too many attempts' });

  const { email, password } = await readJson(req);
  const agent = store.findAgentByEmail(email);
  // Constant-ish comparison is overkill for a demo seed, but don't leak which
  // half was wrong.
  if (!agent || agent.password !== password) {
    return json(res, 401, { message: 'Invalid credentials' });
  }

  const id = sessions.create({ agentId: agent.id, extension: agent.extension });
  res.setHeader('Set-Cookie', sessions.cookieHeader(id));
  return json(res, 200, { agent: publicAgent(agent) });
});

router.post('/api/logout', async (req, res) => {
  const session = sessions.get(req);
  if (session) {
    // Spec §13: revoke the SIP credential so the endpoint can't re-register.
    await provisioner.revoke(session.extension).catch(() => {});
  }
  sessions.destroy(req);
  res.setHeader('Set-Cookie', sessions.cookieHeader('', { clear: true }));
  return json(res, 200, { ok: true });
});

router.get('/api/me', (req, res) => {
  const session = sessions.get(req);
  if (!session) return json(res, 401, { message: 'Unauthenticated' });
  const agent = store.findAgent(session.agentId);
  return json(res, 200, { agent: publicAgent(agent) });
});

// ---- SIP credentials (spec §2) -------------------------------------------

router.get('/api/phone/credentials', async (req, res, url) => {
  const session = sessions.get(req);
  if (!session) return json(res, 401, { message: 'Unauthenticated' });
  if (!credentialLimiter.check(clientKey(req))) return json(res, 429, { message: 'Slow down' });

  const agent = store.findAgent(session.agentId);
  if (!agent) return json(res, 401, { message: 'Unknown agent' });

  // The client may *hint* at an extension, but the server decides — otherwise
  // any agent could register as any extension.
  const requested = url.searchParams.get('extension');
  if (requested && requested !== agent.extension) {
    console.warn(`[sip] agent ${agent.id} asked for ${requested}, forcing ${agent.extension}`);
  }

  try {
    const { password, expires_in, rotated } = await provisioner.issue(agent.extension);
    return json(res, 200, {
      // Exactly the payload shape from spec §2.
      extension: agent.extension,
      sip_domain: config.sipDomain,
      ws_url: config.wsUrl,
      password,
      // Extras the phone understands.
      display_name: agent.name,
      expires_in,
      register_expires: 300,
      ice_servers: [],
      auto_answer: Boolean(agent.auto_answer),
      branding: store.branding,
      agent: publicAgent(agent),
      // Surfaced so the console can show whether rotation actually happened.
      credential_rotated: rotated,
    });
  } catch (err) {
    console.error('[sip] credential issue failed:', err.message);
    return json(res, 503, { message: err.message });
  }
});

// ---- Customer lookup (spec §5) -------------------------------------------

router.get('/api/customers/lookup', (req, res, url) => {
  const session = sessions.get(req);
  if (!session) return json(res, 401, { message: 'Unauthenticated' });

  const phone = url.searchParams.get('phone');
  if (!phone) return json(res, 422, { message: 'phone is required' });

  const customer = store.findCustomerByPhone(phone);
  if (!customer) {
    // 200 with a null-ish body: an unknown caller is not an error, and the
    // phone should still screen-pop "Unknown caller".
    return json(res, 200, { found: false, phone, name: null });
  }
  return json(res, 200, { found: true, ...customer });
});

// ---- Call records (spec §10) --------------------------------------------

router.post('/api/phone/call-records', async (req, res) => {
  const session = sessions.get(req);
  if (!session) return json(res, 401, { message: 'Unauthenticated' });

  const body = await readJson(req);
  if (!body.call_id) return json(res, 422, { message: 'call_id is required' });

  const record = store.upsertCallRecord({
    call_id: body.call_id,
    agent_id: session.agentId,
    direction: body.direction,
    customer_number: body.customer_number,
    extension: body.extension ?? session.extension,
    start_time: body.start_time,
    answer_time: body.answer_time,
    end_time: body.end_time,
    duration: body.duration ?? 0,
    end_reason: body.end_reason,
    customer_id: body.customer?.id ?? null,
    source: 'browser',
  });
  broadcast({ type: 'call_record', record });
  return json(res, 201, { record });
});

router.get('/api/calls/recent', (req, res, url) => {
  const session = sessions.get(req);
  if (!session) return json(res, 401, { message: 'Unauthenticated' });
  return json(res, 200, {
    records: store.recentCalls({
      limit: Number(url.searchParams.get('limit') ?? 25),
      extension: url.searchParams.get('mine') === '1' ? session.extension : undefined,
    }),
  });
});

// ---- Asterisk-side CDR, pushed by the dialplan hangup handler ------------

router.get('/api/asterisk/cdr', (req, res, url) => {
  // Called by curl from the dialplan hangup handler — there is no session
  // cookie, so it authenticates with a shared secret instead.
  if (url.searchParams.get('token') !== config.cdrToken) {
    console.warn(`[cdr] rejected callback with bad token from ${clientKey(req)}`);
    return json(res, 403, { message: 'Invalid CDR token' });
  }
  const cdr = Object.fromEntries(url.searchParams);
  delete cdr.token;
  if (!cdr.call_id) return json(res, 422, { message: 'call_id is required' });
  const record = store.attachAsteriskCdr(cdr);
  console.log(`[cdr] ${cdr.call_id} ${cdr.src} → ${cdr.dst} ${cdr.disposition} ${cdr.billsec}s`);
  broadcast({ type: 'asterisk_cdr', record });
  return json(res, 200, { ok: true });
});

// ---- Browser recording upload (spec §10, optional) ----------------------

router.post('/api/phone/recordings', async (req, res) => {
  const session = sessions.get(req);
  if (!session) return json(res, 401, { message: 'Unauthenticated' });

  const buffer = await readBody(req);
  const { fields, files } = parseMultipart(buffer, req.headers['content-type']);
  const file = files.recording;
  if (!file) return json(res, 422, { message: 'recording file is required' });

  const safeId = String(fields.call_id ?? Date.now()).replace(/[^A-Za-z0-9._-]/g, '_');
  const ext = path.extname(file.filename || '.webm') || '.webm';
  const filename = `${safeId}${ext}`;
  fs.writeFileSync(path.join(config.browserRecordings, filename), file.content);

  const record = store.upsertCallRecord({
    call_id: fields.call_id,
    agent_id: session.agentId,
    customer_number: fields.customer_number,
    direction: fields.direction,
    extension: session.extension,
    start_time: fields.started_at,
    end_time: fields.ended_at,
    duration: Number(fields.duration) || 0,
    browser_recording_path: `uploads/${filename}`,
    source: 'browser',
  });

  console.log(`[rec] stored ${filename} (${file.content.length} bytes)`);
  return json(res, 201, { path: `/uploads/${filename}`, size: file.content.length, record });
});

// ---- Simulated inbound customer call ------------------------------------

router.post('/api/simulate/inbound', async (req, res) => {
  const session = sessions.get(req);
  if (!session) return json(res, 401, { message: 'Unauthenticated' });
  if (!ami.connected) return json(res, 503, { message: 'AMI is not connected — is Asterisk running?' });

  const body = await readJson(req);
  const extension = body.extension ?? session.extension;
  const cli = String(body.cli ?? '0772615908').replace(/[^\d+]/g, '');
  const customer = store.findCustomerByPhone(cli);
  const callerName = body.name ?? customer?.name ?? 'Unknown Caller';

  try {
    // Ring the agent's browser with a spoofed CLI. On answer, the far end lands
    // in auso-sim-inbound and plays audio, so there is something to listen to.
    const result = await ami.action({
      Action: 'Originate',
      Channel: `PJSIP/${extension}`,
      Context: 'auso-sim-inbound',
      Exten: 's',
      Priority: 1,
      CallerID: `"${callerName}" <${cli}>`,
      Timeout: 30000,
      Async: 'true',
      Variable: `AUSO_AGENT=${extension}`,
    });
    console.log(`[sim] originated inbound ${cli} → ${extension}`);
    return json(res, 202, { ok: true, extension, cli, name: callerName, ami: result.Message });
  } catch (err) {
    console.error('[sim] originate failed:', err.message);
    return json(res, 502, { message: err.message });
  }
});

// ---- PBX introspection, for the console's diagnostics panel -------------

router.get('/api/pbx/status', async (req, res) => {
  if (!ami.connected) return json(res, 200, { ami: false, contacts: [], registrations: null });
  try {
    const [endpoints, contacts] = await Promise.all([
      ami.command('pjsip show endpoints'),
      ami.command('pjsip show contacts'),
    ]);
    return json(res, 200, { ami: true, endpoints, contacts });
  } catch (err) {
    return json(res, 200, { ami: true, error: err.message });
  }
});

/** Server-Sent Events so the console can show CDRs arriving live. */
router.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  eventStreams.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    eventStreams.delete(res);
  });
});

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of eventStreams) {
    try {
      res.write(frame);
    } catch {
      eventStreams.delete(res);
    }
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    const route = router.match(req.method, url.pathname);
    if (route) return await route.handler(req, res, url);

    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { message: 'Method not allowed' });

    // Asterisk's MixMonitor output, so the console can play server-side recordings.
    if (url.pathname.startsWith('/recordings/')) {
      if (serveStatic(res, config.serverRecordings, url.pathname.replace('/recordings', ''))) return;
      return text(res, 404, 'Recording not found');
    }
    if (url.pathname.startsWith('/uploads/')) {
      if (serveStatic(res, config.browserRecordings, url.pathname.replace('/uploads', ''))) return;
      return text(res, 404, 'Upload not found');
    }
    // The built phone bundle, served straight out of the package.
    if (url.pathname.startsWith('/vendor/')) {
      const dist = path.join(ROOT, 'packages', 'auso-phone', 'dist');
      if (serveStatic(res, dist, url.pathname.replace('/vendor', ''))) return;
      return text(res, 404, 'Bundle not found — run `npm run build` in packages/auso-phone');
    }

    if (serveStatic(res, path.join(__dirname, 'public'), url.pathname, { fallback: 'index.html' })) return;
    return text(res, 404, 'Not found');
  } catch (err) {
    console.error(`[http] ${req.method} ${url.pathname} failed:`, err);
    if (!res.headersSent) return json(res, 500, { message: err.message });
    return res.end();
  }
});

server.listen(config.port, config.host, () => {
  // Print a URL that is actually usable, not the bind address. Browsers only
  // treat localhost / 127.0.0.1 / [::1] as secure origins, and outside a secure
  // origin navigator.mediaDevices is undefined — so opening http://0.0.0.0:8080
  // would register fine and then fail on the first call with
  // "Media devices not available in insecure contexts."
  const url = ['0.0.0.0', '::', ''].includes(config.host)
    ? `http://localhost:${config.port}`
    : `http://${config.host}:${config.port}`;

  console.log(`
  Auso Call Hub (mock CRM)
  ─────────────────────────────────────────────
  Console   ${url}
  SIP WSS   ${config.wsUrl}
  Domain    ${config.sipDomain}
  Rotation  ${config.rotateCredentials ? 'on — a fresh SIP password per login' : 'off — static passwords'}

  Agents (password: secret)
${store.data.agents.map((a) => `    ${a.email.padEnd(30)} ext ${a.extension}`).join('\n')}
`);
});

// AMI is optional: the console works without it, minus the simulate-inbound
// button and credential rotation.
ami.connect()
  .then(() => console.log('[ami] connected to Asterisk'))
  .catch((err) => console.warn(`[ami] not connected (${err.message}) — start Asterisk with: docker compose -f asterisk/docker-compose.yml up -d`));

ami.on('connected', () => {
  // Re-assert whatever credentials we have already issued after a PBX restart.
  provisioner._writeAuthFile();
  ami.command('pjsip reload').catch(() => {});
});
ami.on('error', (err) => console.warn('[ami]', err.message));

// Relay the Asterisk events the console cares about.
for (const event of ['Newchannel', 'Hangup', 'DialBegin', 'DialEnd', 'BridgeEnter', 'ContactStatus']) {
  ami.on(`event:${event}`, (packet) => broadcast({
    type: 'ami',
    event,
    channel: packet.Channel,
    calleridnum: packet.CallerIDNum,
    connectedlinenum: packet.ConnectedLineNum,
    uniqueid: packet.Uniqueid,
    status: packet.ContactStatus ?? packet.DialStatus,
    endpoint: packet.EndpointName,
  }));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nshutting down');
    ami.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}

function publicAgent(agent) {
  if (!agent) return null;
  const { password, ...rest } = agent;
  return rest;
}

function clientKey(req) {
  return req.socket.remoteAddress ?? 'unknown';
}

export { config, store, ami, provisioner, normalisePhone };
