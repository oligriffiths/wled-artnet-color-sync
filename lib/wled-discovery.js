// Finds WLED devices on the local network with mDNS / DNS-SD, the same way the official WLED app does:
// browse the "_wled._tcp" service and read the "mac" TXT attribute.
import { EventEmitter } from 'node:events';
import { Bonjour } from 'bonjour-service';

export const WLED_SERVICE = '_wled._tcp.local';

/** Converts a bonjour-service Service into a device, or null when it has no IPv4 address yet. */
function toDevice(service) {
  const address = service.addresses?.find((a) => a.includes('.')) ?? service.referer?.address;
  if (!address) {
    return null;
  }
  const port = service.port;
  return {
    name: service.name,
    host: service.host,
    address,
    port,
    mac: service.txt?.mac,
    url: `http://${address}${port === 80 ? '' : `:${port}`}`,
  };
}

/**
 * Browses the network for WLED devices.
 *
 * Events:
 *  - 'device' ({ name, host, address, port, mac?, url })  emitted once per device
 *  - 'error'  (Error)
 */
export class WledDiscovery extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.interval=1000] How often to re-send the browse query while running, in ms
   */
  constructor({ interval = 1000 } = {}) {
    super();
    this.interval = interval;
    this.bonjour = null;
    this.browser = null;
    this.timer = null;
    this.devices = new Map(); // service fqdn -> device
  }

  /** Devices found so far, sorted by name. */
  get found() {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Starts browsing. */
  start() {
    if (this.bonjour) {
      return;
    }
    this.bonjour = new Bonjour({}, (err) => {
      this.emit('error', err);
    });
    this.browser = this.bonjour.find({ type: 'wled', protocol: 'tcp' });
    this.browser.on('up', (service) => {
      this.addService(service);
    });
    // mDNS is lossy; keep asking while running.
    this.timer = setInterval(() => {
      this.browser?.update();
    }, this.interval);
  }

  /** Stops browsing. Devices found so far stay in `found`. */
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }
    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }
  }

  /**
   * Searches for a limited time.
   * @param {object} [options]
   * @param {number} [options.timeout=3000] How long to search, in ms
   * @param {string} [options.name] Only return the device whose instance name or hostname matches (case-insensitive)
   * @param {boolean} [options.first=false] Resolve as soon as one matching device is found
   * @returns {Promise<Array<{ name: string, host: string, address: string, port: number, mac?: string, url: string }>>}
   */
  find({ timeout = 3000, name, first = false } = {}) {
    const wanted = name?.toLowerCase().replace(/\.local$/, '');
    const matches = (d) => {
      return !wanted || wanted === d.name.toLowerCase() || wanted === d.host.toLowerCase().replace(/\.local$/, '');
    };
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        this.off('device', onDevice);
        this.stop();
        resolve(this.found.filter(matches));
      };
      const onDevice = (device) => {
        if (first && matches(device)) {
          done();
        }
      };
      this.on('device', onDevice);
      timer = setTimeout(done, timeout);
      this.start();
    });
  }

  addService(service) {
    const key = service.fqdn ?? service.name;
    if (this.devices.has(key)) {
      return;
    }
    const device = toDevice(service);
    if (!device) {
      return;
    }
    this.devices.set(key, device);
    this.emit('device', device);
  }
}

/**
 * One-off search; shorthand for `new WledDiscovery().find(options)`.
 * @param {Parameters<WledDiscovery['find']>[0]} [options]
 */
export function discoverWled(options) {
  return new WledDiscovery().find(options);
}
