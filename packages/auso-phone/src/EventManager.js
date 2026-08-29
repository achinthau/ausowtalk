import { createLogger } from './logger.js';

const log = createLogger('EventManager');

/**
 * Tiny synchronous event bus.
 *
 * Deliberately dependency-free: this object is the whole surface Laravel /
 * Livewire binds against, so it must never throw into the SIP stack. A handler
 * that throws is logged and the remaining handlers still run.
 */
export class EventManager {
  constructor(options = {}) {
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();
    /** Mirror every event onto `window` as a CustomEvent for Livewire/Alpine. */
    this.domTarget = options.domTarget ?? null;
    this.domPrefix = options.domPrefix ?? 'ausophone:';
    this.history = [];
    this.historyLimit = options.historyLimit ?? 200;
  }

  on(event, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  once(event, handler) {
    const wrapped = (...args) => {
      this.off(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  off(event, handler) {
    if (!handler) {
      this.handlers.delete(event);
      return;
    }
    this.handlers.get(event)?.delete(handler);
  }

  removeAll() {
    this.handlers.clear();
  }

  /**
   * @param {string} event one of PhoneEvents
   * @param {object} payload plain JSON-serialisable object — never a SIP.js object
   */
  emit(event, payload = {}) {
    const enriched = { event, at: new Date().toISOString(), ...payload };
    log.debug(event, enriched);

    this.history.push(enriched);
    if (this.history.length > this.historyLimit) this.history.shift();

    for (const handler of this.handlers.get(event) ?? []) {
      try {
        handler(enriched);
      } catch (err) {
        log.error(`handler for "${event}" threw`, err);
      }
    }
    // '*' handlers see everything — handy for the CRM's debug console.
    for (const handler of this.handlers.get('*') ?? []) {
      try {
        handler(enriched);
      } catch (err) {
        log.error('wildcard handler threw', err);
      }
    }

    if (this.domTarget) {
      try {
        this.domTarget.dispatchEvent(
          new CustomEvent(this.domPrefix + event, { detail: enriched, bubbles: true }),
        );
      } catch (err) {
        log.error('dispatchEvent failed', err);
      }
    }
    return enriched;
  }
}
