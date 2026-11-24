// Connects an ArtnetReceiver to a WledController: maps DMX channels to a WLED color.
import { EventEmitter } from 'node:events';

/**
 * Reads intensity/red/green/blue from incoming DMX and passes them to a WledController.
 *
 * Events (relayed from the receiver and controller):
 *  - 'sent'  ({ r, g, b, bri })      WLED accepted a color
 *  - 'error' (Error)                 err.source is 'artnet' or 'wled'
 */
export class Conductor extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./artnet-receiver.js').ArtnetReceiver} options.receiver
   * @param {import('./wled-controller.js').WledController} options.wled
   * @param {{ intensity?: number, red: number, green: number, blue: number }} [options.channels]
   *   1-based DMX channels (default I1 R2 G3 B4). intensity 0 or omitted means no intensity channel.
   */
  constructor({ receiver, wled, channels = { intensity: 1, red: 2, green: 3, blue: 4 } }) {
    super();
    if (!receiver || !wled) {
      throw new Error('Conductor: receiver and wled are required');
    }
    this.receiver = receiver;
    this.wled = wled;
    this.channels = channels;
    this.useIntensity = channels.intensity > 0;
    this.highestChannel = Math.max(channels.red, channels.green, channels.blue, channels.intensity ?? 0);

    this.onDmx = ({ data }) => {
      this.handleDmx(data);
    };
    this.onSent = (color) => {
      this.emit('sent', color);
    };
    this.onReceiverError = (err) => {
      this.relayError(err, 'artnet');
    };
    this.onWledError = (err) => {
      this.relayError(err, 'wled');
    };
  }

  /** Subscribes to the receiver and controller and starts listening for Art-Net. */
  async start() {
    this.receiver.on('dmx', this.onDmx);
    this.receiver.on('error', this.onReceiverError);
    this.wled.on('sent', this.onSent);
    this.wled.on('error', this.onWledError);
    try {
      await this.receiver.start();
    } catch (err) {
      this.detach();
      throw err;
    }
  }

  /** Stops listening and cancels any queued WLED update. */
  stop() {
    this.detach();
    this.receiver.stop();
    this.wled.stop();
  }

  /** Maps one universe of DMX data to a color. Packets too short to hold every channel are ignored. */
  handleDmx(data) {
    if (data.length < this.highestChannel) {
      return;
    }
    const { red, green, blue, intensity } = this.channels;
    this.wled.setColor({
      r: data[red - 1],
      g: data[green - 1],
      b: data[blue - 1],
      bri: this.useIntensity ? data[intensity - 1] : undefined,
    });
  }

  relayError(err, source) {
    err.source = source;
    this.emit('error', err);
  }

  detach() {
    this.receiver.off('dmx', this.onDmx);
    this.receiver.off('error', this.onReceiverError);
    this.wled.off('sent', this.onSent);
    this.wled.off('error', this.onWledError);
  }
}
