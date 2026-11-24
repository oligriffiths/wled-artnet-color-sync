// Sets the primary color of a WLED device through its JSON API (https://kno.wled.ge/interfaces/json-api/).
import { EventEmitter } from 'node:events';

function sameColor(a, b) {
  return Boolean(a && b) && a.r === b.r && a.g === b.g && a.b === b.b && a.bri === b.bri;
}

/**
 * Rate-limited WLED color setter. Call setColor() as often as you like: only the newest color is
 * sent, at most `rate` times per second, and only when it differs from what WLED last accepted.
 *
 * Events:
 *  - 'sent'  ({ r, g, b, bri })  WLED accepted the color
 *  - 'error' (Error)             a request failed (the color is retried on the next change)
 */
export class WledController extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.url WLED base URL, e.g. http://192.168.1.50
   * @param {number} [options.rate=5] Max requests per second
   * @param {number} [options.transition=0] Transition time in 100ms units
   * @param {number} [options.timeout=2000] Request timeout in ms
   */
  constructor({ url, rate = 5, transition = 0, timeout = 2000 }) {
    super();
    if (!url) {
      throw new Error('WledController: url is required');
    }
    if (!(rate > 0)) {
      throw new Error('WledController: rate must be > 0');
    }
    this.stateUrl = url.replace(/\/+$/, '') + '/json/state';
    this.minInterval = 1000 / rate;
    this.transition = transition;
    this.timeout = timeout;
    this.pending = null;
    this.lastSent = null;
    this.inFlight = false;
    this.lastSendTime = 0;
    this.timer = null;
    this.abort = null;
    this.stopped = false;
  }

  /**
   * Queues a color. bri (0-255) is optional; 0 turns the light off.
   * @param {{ r: number, g: number, b: number, bri?: number }} color
   */
  setColor(color) {
    if (this.stopped) {
      return;
    }
    this.pending = { r: color.r, g: color.g, b: color.b, bri: color.bri };
    this.schedule();
  }

  /** Cancels any queued or in-flight update. A stopped controller ignores further colors. */
  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    this.pending = null;
  }

  schedule() {
    if (this.stopped || this.inFlight || this.timer || !this.pending || sameColor(this.pending, this.lastSent)) {
      return;
    }
    const wait = Math.max(0, this.lastSendTime + this.minInterval - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  async flush() {
    const color = this.pending;
    this.inFlight = true;
    this.lastSendTime = Date.now();
    const body = { on: true, tt: this.transition, seg: [{ col: [[color.r, color.g, color.b]] }] };
    if (color.bri !== undefined) {
      body.bri = color.bri;
      if (color.bri === 0) {
        body.on = false;
      }
    }
    this.abort = new AbortController();
    try {
      const res = await fetch(this.stateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.timeout)]),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      this.lastSent = color;
      this.emit('sent', color);
    } catch (err) {
      // After stop() nobody may be listening, and an unheard 'error' event would throw.
      if (!this.stopped) {
        this.emit('error', err);
      }
    } finally {
      this.abort = null;
      this.inFlight = false;
      this.schedule();
    }
  }
}
