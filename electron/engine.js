// Runs every mapping: one shared ArtnetReceiver per listen address, and a Conductor + WledController
// per enabled mapping. Plain Node (no Electron APIs), so it can be reused outside the app.
import { EventEmitter } from 'node:events';
import { ArtnetReceiver, resolveInterfaceAddress } from '../lib/artnet-receiver.js';
import { Conductor } from '../lib/conductor.js';
import { WledController } from '../lib/wled-controller.js';

const FRAME_FPS = 20;

/** Adds http:// when missing and validates the result. Throws on an empty or invalid address. */
export function normalizeWledUrl(value) {
  let url = String(value ?? '').trim();
  if (!url) {
    throw new Error('no WLED controller set');
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  new URL(url);
  return url;
}

/** Identifies everything that affects a running sender; a change means it must be rebuilt. */
function runKey(mapping, address) {
  const { name, enabled, ...rest } = mapping;
  return JSON.stringify({ ...rest, address });
}

/**
 * Events:
 *  - 'frames' (Array<{ address, universe, source, fps, data: number[] }>)  latest DMX per address+universe,
 *    batched at 20 fps
 *  - 'status' ({ [mappingId]: { running, error?, lastSent? } })
 */
export class Engine extends EventEmitter {
  constructor() {
    super();
    this.receivers = new Map(); // address -> { receiver, ready: Promise, error? }
    this.runs = new Map(); // mapping id -> { conductor, key }
    this.statuses = {};
    this.previews = new Map(); // owner (e.g. a window id) -> adapter id to listen on for live display
    this.mappings = [];
    this.pending = new Map(); // `${address}|${universe}` -> frame not yet sent to the UI
    this.rates = new Map(); // `${address}|${universe}` -> arrival times in the last second
    this.timer = setInterval(() => {
      this.flushFrames();
    }, 1000 / FRAME_FPS);
    this.applying = Promise.resolve();
  }

  /** Replaces the mapping set and reconciles sockets and senders. Calls are serialized. */
  apply(mappings) {
    this.mappings = mappings;
    this.applying = this.applying.then(() => this.reconcile());
    return this.applying;
  }

  /**
   * Also listens on this adapter so a window can show its DMX without a mapping using it.
   * @param {string|number} owner Who wants the preview; each owner has at most one.
   * @param {string|null} interfaceId null stops this owner's preview.
   */
  setPreview(owner, interfaceId) {
    if (interfaceId) {
      this.previews.set(owner, interfaceId);
    } else {
      this.previews.delete(owner);
    }
    return this.apply(this.mappings);
  }

  async reconcile() {
    const previous = this.statuses;
    this.statuses = {};

    // Work out which addresses are needed, keeping per-mapping resolution errors.
    const addressOf = new Map();
    const wanted = new Set();
    for (const m of this.mappings) {
      try {
        const address = resolveInterfaceAddress(m.interface);
        addressOf.set(m.id, address);
        wanted.add(address);
      } catch (err) {
        this.statuses[m.id] = { running: false, error: err.message };
      }
    }
    for (const interfaceId of this.previews.values()) {
      try {
        wanted.add(resolveInterfaceAddress(interfaceId));
      } catch {
        // The window shows its own message for an unknown adapter.
      }
    }

    // Stop senders whose mapping changed, was disabled or was removed; unchanged ones keep running
    // (and keep their status) so editing one mapping doesn't disturb the others.
    const keys = new Map(this.mappings.map((m) => [m.id, runKey(m, addressOf.get(m.id))]));
    for (const [id, run] of this.runs) {
      const mapping = this.mappings.find((m) => m.id === id);
      if (!mapping?.enabled || keys.get(id) !== run.key || !addressOf.has(id)) {
        run.conductor.stop({ stopReceiver: false });
        this.runs.delete(id);
      }
    }

    for (const [address, entry] of this.receivers) {
      if (!wanted.has(address)) {
        entry.receiver.stop();
        this.receivers.delete(address);
      }
    }
    for (const address of wanted) {
      if (!this.receivers.has(address)) {
        this.openReceiver(address);
      }
    }
    await Promise.all([...this.receivers.values()].map((e) => e.ready));

    for (const m of this.mappings) {
      if (this.statuses[m.id]) {
        continue;
      }
      const entry = this.receivers.get(addressOf.get(m.id));
      if (entry.error) {
        this.statuses[m.id] = { running: false, error: `can't listen on ${addressOf.get(m.id)}: ${entry.error}` };
        continue;
      }
      if (!m.enabled) {
        this.statuses[m.id] = { running: false };
        continue;
      }
      if (this.runs.has(m.id)) {
        this.statuses[m.id] = previous[m.id] ?? { running: true };
        continue;
      }
      try {
        this.startRun(m, entry.receiver, keys.get(m.id));
        this.statuses[m.id] = { running: true };
      } catch (err) {
        this.statuses[m.id] = { running: false, error: err.message };
      }
    }
    this.emitStatus();
  }

  openReceiver(address) {
    const receiver = new ArtnetReceiver({ address });
    const entry = { receiver, error: null };
    receiver.on('dmx', ({ universe, source, data }) => {
      const key = `${address}|${universe}`;
      const now = Date.now();
      const times = this.rates.get(key) ?? [];
      times.push(now);
      while (times[0] < now - 1000) {
        times.shift();
      }
      this.rates.set(key, times);
      this.pending.set(key, { address, universe, source, fps: times.length, data });
    });
    receiver.on('error', (err) => {
      entry.error = err.message;
    });
    entry.ready = receiver.start().catch((err) => {
      entry.error = err.message;
    });
    this.receivers.set(address, entry);
  }

  startRun(mapping, receiver, key) {
    const url = normalizeWledUrl(mapping.wled?.url);
    const { channels } = mapping;
    const wled = new WledController({ url, rate: Number(mapping.rate) || 5 });
    const conductor = new Conductor({
      receiver,
      wled,
      universe: Number(mapping.universe),
      channels: { ...channels, intensity: mapping.includeIntensity ? channels.intensity : 0 },
    });
    conductor.on('sent', (color) => {
      this.statuses[mapping.id] = { running: true, lastSent: color };
      this.emitStatus();
    });
    conductor.on('error', (err) => {
      this.statuses[mapping.id] = { ...this.statuses[mapping.id], error: err.message };
      this.emitStatus();
    });
    // The receiver is already listening, so this only subscribes.
    conductor.start();
    this.runs.set(mapping.id, { conductor, key });
  }

  flushFrames() {
    if (this.pending.size === 0) {
      return;
    }
    const frames = [...this.pending.values()].map((f) => ({ ...f, data: Array.from(f.data) }));
    this.pending.clear();
    this.emit('frames', frames);
  }

  emitStatus() {
    this.emit('status', { ...this.statuses });
  }

  /** Stops everything. */
  close() {
    clearInterval(this.timer);
    for (const { conductor } of this.runs.values()) {
      conductor.stop({ stopReceiver: false });
    }
    this.runs.clear();
    for (const { receiver } of this.receivers.values()) {
      receiver.stop();
    }
    this.receivers.clear();
  }
}
