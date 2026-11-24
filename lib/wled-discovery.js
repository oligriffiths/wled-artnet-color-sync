// Finds WLED devices on the local network with mDNS / DNS-SD, the same way the official WLED app does:
// browse the "_wled._tcp" service and read the "mac" TXT attribute.
import dgram from 'node:dgram';

export const WLED_SERVICE = '_wled._tcp.local';
const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const bufs = parts.map((p) => {
    const label = Buffer.from(p, 'utf8');
    return Buffer.concat([Buffer.from([label.length]), label]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

/** Builds a one-question mDNS query. */
function buildQuery(name, type) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // QDCOUNT
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2); // class IN
  return Buffer.concat([header, encodeName(name), tail]);
}

/** Reads a (possibly compressed) domain name. Returns { name, end }, end being the offset after it. */
function readName(buf, offset) {
  const labels = [];
  let end = -1;
  let pos = offset;
  for (let hops = 0; hops < 64; hops++) {
    if (pos >= buf.length) {
      throw new Error('name out of range');
    }
    const len = buf[pos];
    if (len === 0) {
      if (end < 0) {
        end = pos + 1;
      }
      return { name: labels.join('.'), end };
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) {
        end = pos + 2;
      }
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new Error('name compression loop');
}

/** Parses every resource record in an mDNS response. Malformed packets return []. */
export function parseRecords(buf) {
  try {
    if (buf.length < 12) {
      return [];
    }
    const qd = buf.readUInt16BE(4);
    const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    let pos = 12;
    for (let i = 0; i < qd; i++) {
      pos = readName(buf, pos).end + 4;
    }
    const records = [];
    for (let i = 0; i < total; i++) {
      const { name, end } = readName(buf, pos);
      const type = buf.readUInt16BE(end);
      const len = buf.readUInt16BE(end + 8);
      const data = end + 10;
      pos = data + len;
      if (pos > buf.length) {
        break;
      }
      const record = { name: name.toLowerCase(), type };
      if (type === TYPE_A && len === 4) {
        record.address = [...buf.subarray(data, data + 4)].join('.');
      } else if (type === TYPE_PTR) {
        record.target = readName(buf, data).name;
      } else if (type === TYPE_SRV) {
        record.port = buf.readUInt16BE(data + 4);
        record.target = readName(buf, data + 6).name.toLowerCase();
      } else if (type === TYPE_TXT) {
        record.txt = {};
        let p = data;
        while (p < pos) {
          const entry = buf.toString('utf8', p + 1, p + 1 + buf[p]);
          p += 1 + buf[p];
          const eq = entry.indexOf('=');
          if (eq > 0) {
            record.txt[entry.slice(0, eq)] = entry.slice(eq + 1);
          }
        }
      }
      records.push(record);
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Discovers WLED devices.
 * @param {object} [options]
 * @param {number} [options.timeout=3000] How long to listen, in ms
 * @param {string} [options.name] Only return the device whose instance name or hostname matches (case-insensitive)
 * @param {boolean} [options.first=false] Resolve as soon as one device is found
 * @returns {Promise<Array<{ name: string, host: string, address: string, port: number, mac?: string, url: string }>>}
 */
export function discoverWled({ timeout = 3000, name, first = false } = {}) {
  const wanted = name?.toLowerCase().replace(/\.local$/, '');
  return new Promise((resolve, reject) => {
    // A query sent from a non-5353 port is a "legacy unicast" query: responders answer straight back to
    // this socket, so we don't compete with the system mDNS responder for port 5353.
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const instances = new Map(); // instance full name -> { srv, txt }
    const addresses = new Map(); // hostname -> IPv4
    const devices = new Map();
    let timer;
    let resendTimer;

    const finish = () => {
      clearTimeout(timer);
      clearInterval(resendTimer);
      socket.close();
      resolve([...devices.values()]);
    };

    const query = (qname, type) => {
      socket.send(buildQuery(qname, type), MDNS_PORT, MDNS_ADDRESS, () => {});
    };

    const collect = () => {
      for (const [instance, info] of instances) {
        if (devices.has(instance) || !info.srv) {
          continue;
        }
        const address = addresses.get(info.srv.target);
        if (!address) {
          query(info.srv.target, TYPE_A);
          continue;
        }
        const label = instance.slice(0, -(WLED_SERVICE.length + 1));
        const host = info.srv.target;
        if (wanted && wanted !== label.toLowerCase() && wanted !== host.replace(/\.local$/, '')) {
          continue;
        }
        const port = info.srv.port;
        devices.set(instance, {
          name: label,
          host,
          address,
          port,
          mac: info.txt?.mac,
          url: `http://${address}${port === 80 ? '' : `:${port}`}`,
        });
        if (first) {
          finish();
          return;
        }
      }
    };

    socket.on('message', (msg) => {
      for (const r of parseRecords(msg)) {
        if (r.type === TYPE_PTR && r.name === WLED_SERVICE) {
          const key = r.target.toLowerCase();
          if (!instances.has(key)) {
            instances.set(key, {});
            query(r.target, TYPE_SRV);
          }
        } else if (r.type === TYPE_SRV || r.type === TYPE_TXT) {
          const info = instances.get(r.name) ?? {};
          if (r.type === TYPE_SRV) {
            info.srv = r;
          } else {
            info.txt = r.txt;
          }
          instances.set(r.name, info);
        } else if (r.type === TYPE_A) {
          addresses.set(r.name, r.address);
        }
      }
      collect();
    });

    socket.once('error', (err) => {
      clearTimeout(timer);
      clearInterval(resendTimer);
      socket.close();
      reject(err);
    });

    socket.bind(0, () => {
      query(WLED_SERVICE, TYPE_PTR);
      // mDNS is lossy; ask again a couple of times within the window.
      resendTimer = setInterval(() => {
        query(WLED_SERVICE, TYPE_PTR);
      }, 1000);
      timer = setTimeout(finish, timeout);
    });
  });
}
