import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Issues short-lived SIP credentials (spec §2 security recommendation).
 *
 * The browser must never see the permanent PJSIP password. Instead, on every
 * agent login this rewrites the auth section for that extension with a freshly
 * generated password and asks Asterisk to reload PJSIP. The password the page
 * receives is therefore valid only for the current agent session and is
 * invalidated the moment the same extension logs in again.
 *
 * This is the same technique to use in production — the only difference is that
 * a real deployment would keep the auth rows in PJSIP realtime (ODBC) instead
 * of a flat file, so no reload is needed.
 */
export class SipProvisioner {
  /**
   * @param {object} opts
   * @param {string} opts.authFile   path to dynamic/pjsip_auth.conf
   * @param {import('./ami.mjs').AmiClient} opts.ami
   * @param {string[]} opts.extensions extensions defined in pjsip.conf
   * @param {number} opts.ttlSeconds  how long an issued credential is advertised as valid
   * @param {boolean} opts.rotate     false → hand out the static file password
   */
  constructor({ authFile, ami, extensions, ttlSeconds = 3600, rotate = true }) {
    this.authFile = authFile;
    this.ami = ami;
    this.extensions = extensions;
    this.ttlSeconds = ttlSeconds;
    this.rotate = rotate;
    /** @type {Map<string, {password: string, issuedAt: number, expiresAt: number}>} */
    this.sessions = new Map();
    /** Serialises reloads so two simultaneous logins can't interleave writes. */
    this._queue = Promise.resolve();
  }

  /**
   * @param {string} extension
   * @param {object} [opts]
   * @param {boolean} [opts.force] rotate even if a valid session password exists
   * @returns {Promise<{password: string, expires_in: number, rotated: boolean}>}
   */
  issue(extension, { force = false } = {}) {
    if (!this.extensions.includes(extension)) {
      throw new Error(`Extension ${extension} is not provisioned on the PBX`);
    }

    if (!this.rotate) {
      const password = this._readPassword(extension);
      if (!password) throw new Error(`No password found for ${extension} in ${this.authFile}`);
      return Promise.resolve({ password, expires_in: this.ttlSeconds, rotated: false });
    }

    // Reuse a live session password rather than rotating on every request.
    //
    // Rotating unconditionally breaks two ordinary cases: an agent with the
    // console open in two tabs, and the phone's own pre-expiry credential
    // refresh — each new password invalidates the other holder, which then
    // re-fetches and invalidates back, forever. The credential is still
    // short-lived; it is bounded by ttlSeconds, not by request count.
    const existing = this.sessions.get(extension);
    if (!force && existing && existing.expiresAt > Date.now()) {
      return Promise.resolve({
        password: existing.password,
        expires_in: Math.max(1, Math.floor((existing.expiresAt - Date.now()) / 1000)),
        rotated: false,
        reused: true,
      });
    }

    // Chain onto the queue so concurrent logins serialise.
    const run = this._queue.then(() => this._rotate(extension));
    this._queue = run.catch(() => {});
    return run;
  }

  async _rotate(extension) {
    // 24 bytes of base64url — long enough that a leaked page source is useless
    // once the session ends, and safe for a SIP password (no ':' or '@').
    const password = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();

    this.sessions.set(extension, {
      password,
      issuedAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
    });

    this._writeAuthFile();

    // Asterisk needs to re-read the auth sections. `pjsip reload` keeps existing
    // dialogs and registrations up; only credentials change.
    if (this.ami?.connected) {
      await this.ami.command('pjsip reload');
      // The AMI Command action returns as soon as the CLI command is dispatched,
      // but `pjsip reload` is applied asynchronously. Returning here would hand
      // the browser a password Asterisk does not know yet, and its REGISTER
      // would be rejected. Wait until the PBX actually reports the new value.
      await this._waitForPassword(extension, password);
    } else {
      console.warn('[sip] AMI not connected — Asterisk will keep the previous password until reload');
      // Roll back so we don't hand out a password Asterisk does not know.
      this.sessions.delete(extension);
      const fallback = this._readPassword(extension);
      this._writeAuthFile();
      if (!fallback) throw new Error('Cannot issue credentials: AMI is down and no static password exists');
      return { password: fallback, expires_in: this.ttlSeconds, rotated: false };
    }

    return { password, expires_in: this.ttlSeconds, rotated: true };
  }

  /** Revoke on logout so the extension can't re-register with the old password. */
  async revoke(extension) {
    if (!this.rotate || !this.sessions.has(extension)) return false;
    this.sessions.delete(extension);
    this._writeAuthFile();
    if (this.ami?.connected) await this.ami.command('pjsip reload').catch(() => {});
    return true;
  }

  /**
   * Poll Asterisk until `pjsip show auth <ext>-auth` reports the password we
   * just wrote. Bounded — if the reload is wedged we would rather hand out the
   * credential and let the phone's 401 retry path deal with it than hang the
   * login indefinitely.
   */
  async _waitForPassword(extension, expected, { timeoutMs = 5000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const out = await this.ami.command(`pjsip show auth ${extension}-auth`);
        if (out.includes(expected)) return true;
      } catch (err) {
        console.warn(`[sip] could not verify auth for ${extension}: ${err.message}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    console.warn(`[sip] Asterisk did not pick up the new password for ${extension} within ${timeoutMs}ms`);
    return false;
  }

  /** Read the currently-configured password straight out of the file. */
  _readPassword(extension) {
    const text = fs.readFileSync(this.authFile, 'utf8');
    const section = new RegExp(`\\[${extension}-auth\\][^\\[]*`, 'i').exec(text);
    if (!section) return null;
    return /^\s*password\s*=\s*(.+)$/m.exec(section[0])?.[1]?.trim() ?? null;
  }

  /**
   * Rewrite the whole file. Extensions with an active session get their session
   * password; the rest keep a stable per-extension development default so the
   * PBX still works when the CRM is not running.
   */
  _writeAuthFile() {
    const header = [
      ';',
      '; GENERATED FILE — rewritten by server/sip-provisioner.mjs on every agent login.',
      '; Hand edits will be lost. See the header comment in git for the defaults.',
      `; Last written: ${new Date().toISOString()}`,
      ';',
      '',
    ];
    const body = this.extensions.flatMap((ext) => {
      const session = this.sessions.get(ext);
      let password;
      let note = '; static development default';
      if (session) {
        password = session.password;
        note = `; session issued ${new Date(session.issuedAt).toISOString()}`;
      } else if (!this.rotate) {
        // Against a PBX we don't manage, preserve the password already in the
        // file (set by the admin to match the PBX) instead of resetting it to
        // the development default, which would break registration.
        password = this._readPassword(ext) ?? `auso-dev-${ext}`;
        note = '; static password, matches the public PBX';
      } else {
        password = `auso-dev-${ext}`;
      }
      return [
        `[${ext}-auth]`,
        'type=auth',
        'auth_type=userpass',
        `username=${ext}`,
        `password=${password}`,
        note,
        '',
      ];
    });
    // Atomic replace — Asterisk must never read a half-written file.
    const tmp = `${this.authFile}.tmp`;
    fs.writeFileSync(tmp, header.concat(body).join('\n'));
    fs.renameSync(tmp, this.authFile);
  }
}
