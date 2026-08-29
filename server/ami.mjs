import net from 'node:net';
import { EventEmitter } from 'node:events';

/**
 * Minimal Asterisk Manager Interface client.
 *
 * Only what the mock CRM needs: login, Action/Response round-trips, and event
 * fan-out. Written against the raw protocol so the server keeps zero runtime
 * dependencies.
 */
export class AmiClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 5038, username = 'auso', secret = 'auso-dev-ami' } = {}) {
    super();
    this.options = { host, port, username, secret };
    this.socket = null;
    this.connected = false;
    this.buffer = '';
    this.actionId = 0;
    /** @type {Map<string, {resolve: Function, reject: Function, lines: object[], timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    this.reconnectDelay = 2000;
    this._closing = false;
  }

  connect() {
    if (this.socket) return Promise.resolve(this);
    this._closing = false;

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.options.port, this.options.host);
      this.socket = socket;
      socket.setEncoding('utf8');
      socket.setKeepAlive(true, 15000);

      const onError = (err) => {
        this.socket = null;
        this.connected = false;
        reject(err);
        this._scheduleReconnect();
      };

      socket.once('error', onError);

      socket.once('data', async (greeting) => {
        if (!/Asterisk Call Manager/i.test(greeting)) {
          socket.destroy();
          return reject(new Error(`Unexpected AMI greeting: ${greeting.slice(0, 60)}`));
        }
        socket.off('error', onError);
        socket.on('error', (err) => this.emit('error', err));
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => {
          this.connected = false;
          this.socket = null;
          this.emit('close');
          this._scheduleReconnect();
        });

        try {
          await this.action({
            Action: 'Login',
            Username: this.options.username,
            Secret: this.options.secret,
            Events: 'on',
          });
          this.connected = true;
          this.emit('connected');
          resolve(this);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  close() {
    this._closing = true;
    clearTimeout(this._reconnectTimer);
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  _scheduleReconnect() {
    if (this._closing) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {});
    }, this.reconnectDelay);
  }

  /**
   * Send an action and resolve with its response packet.
   * Multi-packet responses (EventList) are collected until the terminating
   * "Complete" event.
   */
  action(fields, { timeoutMs = 8000 } = {}) {
    if (!this.socket) return Promise.reject(new Error('AMI is not connected'));

    const id = String(++this.actionId);
    const lines = Object.entries({ ...fields, ActionID: id }).map(([k, v]) => `${k}: ${v}`);
    // Variable: headers may repeat; callers pass them as an array.
    const payload = `${lines.flat().join('\r\n')}\r\n\r\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`AMI action ${fields.Action} timed out`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, packets: [], timer });
      this.socket.write(payload);
    });
  }

  /** Convenience for `Action: Command` (CLI passthrough). */
  async command(cli) {
    const res = await this.action({ Action: 'Command', Command: cli });
    return res.Output ?? res.output ?? '';
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    // AMI packets are separated by a blank line.
    while ((idx = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 4);
      this._handlePacket(parsePacket(raw));
    }
  }

  _handlePacket(packet) {
    const id = packet.ActionID;
    const waiter = id ? this.pending.get(id) : null;

    if (waiter) {
      // An EventList response streams events until "Complete".
      if (packet.EventList === 'start') {
        waiter.packets.push(packet);
        return;
      }
      if (packet.Event && packet.EventList !== 'Complete') {
        waiter.packets.push(packet);
        return;
      }
      clearTimeout(waiter.timer);
      this.pending.delete(id);
      const result = { ...packet, packets: waiter.packets };
      if (/error/i.test(packet.Response ?? '')) {
        waiter.reject(new Error(packet.Message || 'AMI error'));
      } else {
        waiter.resolve(result);
      }
      return;
    }

    if (packet.Event) {
      this.emit('event', packet);
      this.emit(`event:${packet.Event}`, packet);
    }
  }
}

/**
 * AMI packets are `Key: value` lines. `Output:` repeats for CLI command
 * responses, so collapse duplicates into a newline-joined string.
 */
function parsePacket(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep === -1) {
      if (line.trim()) out.Output = out.Output ? `${out.Output}\n${line}` : line;
      continue;
    }
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    out[key] = key in out ? `${out[key]}\n${value}` : value;
  }
  return out;
}
