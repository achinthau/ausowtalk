import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Tiny router + helpers so the server keeps zero runtime dependencies. */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.gsm': 'audio/x-gsm',
};

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, pattern, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  del(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    return this.routes.find((r) => r.method === method && r.pattern === pathname) ?? null;
  }
}

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

export async function readBody(req, { limit = 20 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const body = await readBody(req, { limit: 1024 * 1024 });
  if (!body.length) return {};
  return JSON.parse(body.toString('utf8'));
}

/**
 * Minimal multipart/form-data parser — just enough for the single-file
 * recording upload. Splits on the boundary and pulls out headers per part.
 */
export function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundaryMatch) throw new Error('Missing multipart boundary');
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);

  const parts = [];
  let start = buffer.indexOf(boundary);
  if (start === -1) throw new Error('Malformed multipart body');
  start += boundary.length;

  while (start < buffer.length) {
    // "--" immediately after a boundary marks the end of the body.
    if (buffer.slice(start, start + 2).toString() === '--') break;
    // Skip the CRLF after the boundary.
    if (buffer.slice(start, start + 2).toString() === '\r\n') start += 2;

    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const rawHeaders = buffer.slice(start, headerEnd).toString('utf8');

    const bodyStart = headerEnd + 4;
    const next = buffer.indexOf(boundary, bodyStart);
    const bodyEnd = next === -1 ? buffer.length : next - 2; // strip trailing CRLF
    const content = buffer.slice(bodyStart, bodyEnd);

    const disposition = /content-disposition:([^\r\n]*)/i.exec(rawHeaders)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    const type = /content-type:\s*([^\r\n]*)/i.exec(rawHeaders)?.[1];

    if (name) parts.push({ name, filename, type, content });

    if (next === -1) break;
    start = next + boundary.length;
  }

  const fields = {};
  const files = {};
  for (const part of parts) {
    if (part.filename) files[part.name] = part;
    else fields[part.name] = part.content.toString('utf8');
  }
  return { fields, files };
}

/** Serve a file from `root`, refusing anything that escapes it. */
export function serveStatic(res, root, urlPath, { fallback } = {}) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  let target = path.join(root, decoded === '/' ? '/index.html' : decoded);

  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    text(res, 403, 'Forbidden');
    return true;
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    target = path.join(resolved, 'index.html');
  } else {
    target = resolved;
  }

  if (!fs.existsSync(target)) {
    if (!fallback) return false;
    target = path.join(root, fallback);
    if (!fs.existsSync(target)) return false;
  }

  const stat = fs.statSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    // Dev server: never cache, so an edit + reload is enough.
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

// ---- Cookie-based sessions -------------------------------------------------

export class SessionStore {
  constructor({ ttlMs = 8 * 3600 * 1000, cookieName = 'auso_session' } = {}) {
    this.ttlMs = ttlMs;
    this.cookieName = cookieName;
    /** @type {Map<string, {data: object, expiresAt: number}>} */
    this.sessions = new Map();
    // Reap expired sessions hourly; unref so it never holds the process open.
    setInterval(() => this._reap(), 3600_000).unref();
  }

  create(data) {
    const id = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(id, { data, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  get(req) {
    const id = parseCookies(req.headers.cookie)[this.cookieName];
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return { id, ...session.data };
  }

  destroy(req) {
    const id = parseCookies(req.headers.cookie)[this.cookieName];
    if (id) this.sessions.delete(id);
    return id;
  }

  cookieHeader(id, { clear = false } = {}) {
    const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (clear) attrs.push('Max-Age=0');
    else attrs.push(`Max-Age=${Math.floor(this.ttlMs / 1000)}`);
    return `${this.cookieName}=${clear ? '' : id}; ${attrs.join('; ')}`;
  }

  _reap() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(id);
  }
}

export function parseCookies(header) {
  const out = {};
  for (const pair of (header ?? '').split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

/** Fixed-window rate limiter — the credentials endpoint must not be brute-forceable. */
export class RateLimiter {
  constructor({ windowMs = 60_000, max = 30 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    setInterval(() => this.hits.clear(), windowMs).unref();
  }

  check(key) {
    const count = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, count);
    return count <= this.max;
  }
}
