// Art-Net DMX receiver. Emits 'dmx' events for incoming ArtDmx packets.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

export const ARTNET_PORT = 6454;
const ARTNET_ID = Buffer.from('Art-Net\0', 'ascii');
const OP_DMX = 0x5000;

/**
 * Parses an ArtDmx packet.
 * @param {Buffer} buf
 * @returns {{ universe: number, sequence: number, data: Buffer } | null} null for anything that is not ArtDmx
 */
export function parseArtDmx(buf) {
  if (buf.length < 18 || !buf.subarray(0, 8).equals(ARTNET_ID)) {
    return null;
  }
  if (buf.readUInt16LE(8) !== OP_DMX) {
    return null;
  }
  const length = buf.readUInt16BE(16);
  return {
    universe: ((buf[15] & 0x7f) << 8) | buf[14],
    sequence: buf[12],
    data: buf.subarray(18, 18 + Math.min(length, 512, buf.length - 18)),
  };
}

/**
 * Listens for Art-Net DMX on UDP 6454.
 *
 * Events:
 *  - 'dmx'   ({ universe, sequence, data, source })  data is a Buffer of channel values (channel 1 = data[0])
 *  - 'error' (Error)
 */
export class ArtnetReceiver extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.address='0.0.0.0'] Local address to bind. Bind 127.0.0.1 to win
   *   localhost unicast over other Art-Net apps that bind the wildcard address.
   * @param {number} [options.port=6454]
   * @param {number} [options.universe] Only emit packets for this universe (all universes when omitted)
   */
  constructor({ address = '0.0.0.0', port = ARTNET_PORT, universe } = {}) {
    super();
    this.address = address;
    this.port = port;
    this.universe = universe;
    this.socket = null;
  }

  /** Binds the socket. Resolves once listening. */
  start() {
    if (this.socket) {
      return Promise.resolve();
    }
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (msg, rinfo) => {
      const dmx = parseArtDmx(msg);
      if (!dmx) {
        return;
      }
      if (this.universe !== undefined && dmx.universe !== this.universe) {
        return;
      }
      this.emit('dmx', { ...dmx, source: rinfo.address });
    });
    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.port, this.address, () => {
        socket.off('error', reject);
        socket.setBroadcast(true);
        socket.on('error', (err) => this.emit('error', err));
        resolve();
      });
    });
  }

  /** Closes the socket. */
  stop() {
    if (!this.socket) {
      return;
    }
    this.socket.close();
    this.socket = null;
  }
}
