#!/usr/bin/env node
// Art-Net receiver that maps DMX channels to the primary color of a WLED device.
import { parseArgs } from 'node:util';
import { ArtnetReceiver, ARTNET_PORT } from './lib/artnet-receiver.js';
import { WledController } from './lib/wled-controller.js';

const { values: args } = parseArgs({
  options: {
    wled: { type: 'string', default: 'http://192.168.1.219' },
    universe: { type: 'string', short: 'u', default: '0' },
    channel: { type: 'string', short: 'c', default: '1' },
    intensity: { type: 'string', short: 'i' },
    red: { type: 'string', short: 'r' },
    green: { type: 'string', short: 'g' },
    blue: { type: 'string', short: 'b' },
    bind: { type: 'string', default: '127.0.0.1' },
    rate: { type: 'string', default: '5' },
    transition: { type: 'string', default: '0' },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`Usage: node index.js [options]

  --wled <url>          WLED base URL (default http://192.168.1.219)
  -u, --universe <n>    Art-Net universe / port address 0-32767 (default 0)
  -c, --channel <n>     Start channel: intensity=n, red=n+1, green=n+2, blue=n+3 (default 1)
  -i, --intensity <n>   Intensity channel; 0 disables intensity (overrides -c)
  -r, --red <n>         Red channel (overrides -c)
  -g, --green <n>       Green channel (overrides -c)
  -b, --blue <n>        Blue channel (overrides -c)
  --rate <hz>           Max HTTP updates per second to WLED (default 5)
  --transition <n>      WLED transition time in 100ms units (default 0)
  --bind <ip>           Address to listen on (default 127.0.0.1; 0.0.0.0 for network/broadcast)
  -v, --verbose         Log every color sent

Requests are only sent when the color or intensity changes.`);
  process.exit(0);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function intArg(name, value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`--${name} must be an integer from ${min} to ${max} (got "${value}")`);
  }
  return n;
}

const universe = intArg('universe', args.universe, 0, 32767);
const start = intArg('channel', args.channel, 1, 512);
const channels = {
  intensity: intArg('intensity', args.intensity ?? start, 0, 512),
  red: intArg('red', args.red ?? start + 1, 1, 512),
  green: intArg('green', args.green ?? start + 2, 1, 512),
  blue: intArg('blue', args.blue ?? start + 3, 1, 512),
};
const rate = Number(args.rate);
if (!(rate > 0)) {
  fail(`--rate must be a positive number (got "${args.rate}")`);
}
const transition = intArg('transition', args.transition, 0, 65535);
const useIntensity = channels.intensity > 0;
const highestChannel = Math.max(...Object.values(channels));

const wled = new WledController({ url: args.wled, rate, transition });
wled.on('sent', (color) => {
  if (args.verbose) {
    const hex = [color.r, color.g, color.b].map((v) => v.toString(16).padStart(2, '0')).join('');
    console.log(`-> #${hex}${color.bri !== undefined ? ` bri ${color.bri}` : ''}`);
  }
});
wled.on('error', (err) => {
  console.error(`WLED update failed: ${err.message}`);
});

const receiver = new ArtnetReceiver({ address: args.bind, universe });
receiver.on('dmx', ({ data }) => {
  if (data.length < highestChannel) {
    return;
  }
  wled.setColor({
    r: data[channels.red - 1],
    g: data[channels.green - 1],
    b: data[channels.blue - 1],
    bri: useIntensity ? data[channels.intensity - 1] : undefined,
  });
});
receiver.on('error', (err) => {
  fail(`socket error: ${err.message}`);
});

try {
  await receiver.start();
} catch (err) {
  fail(`could not listen on ${args.bind}:${ARTNET_PORT}: ${err.message}`);
}
const map = `${useIntensity ? `I${channels.intensity} ` : ''}R${channels.red} G${channels.green} B${channels.blue}`;
console.log(`Listening on ${args.bind}:${ARTNET_PORT}, universe ${universe}, channels ${map}, max ${rate} Hz -> ${args.wled}`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    receiver.stop();
    wled.stop();
    process.exit(0);
  });
}
