#!/usr/bin/env node
// Art-Net receiver that maps DMX channels to the primary color of a WLED device.
import { parseArgs } from 'node:util';
import { ArtnetReceiver, ARTNET_PORT, resolveInterfaceAddress } from './lib/artnet-receiver.js';
import { WledController } from './lib/wled-controller.js';

const { values: args } = parseArgs({
  options: {
    wled: { type: 'string', short: 'w' },
    universe: { type: 'string', short: 'u', default: '0' },
    channel: { type: 'string', short: 'c', default: '1' },
    intensity: { type: 'string', short: 'i' },
    red: { type: 'string', short: 'r' },
    green: { type: 'string', short: 'g' },
    blue: { type: 'string', short: 'b' },
    interface: { type: 'string', short: 'n', default: 'localhost' },
    rate: { type: 'string', default: '5' },
    transition: { type: 'string', default: '0' },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`Usage: node index.js [options]

  -w, --wled <url>      WLED address, e.g. http://192.168.1.50 or 192.168.1.50
                        (required; or set the WLED_URL environment variable)
  -u, --universe <n>    Art-Net universe / port address 0-32767 (default 0)
  -c, --channel <n>     Start channel: intensity=n, red=n+1, green=n+2, blue=n+3 (default 1)
  -i, --intensity <n>   Intensity channel; 0 disables intensity (overrides -c)
  -r, --red <n>         Red channel (overrides -c)
  -g, --green <n>       Green channel (overrides -c)
  -b, --blue <n>        Blue channel (overrides -c)
  --rate <hz>           Max HTTP updates per second to WLED (default 5)
  --transition <n>      WLED transition time in 100ms units (default 0)
  -n, --interface <x>   Network adapter to receive Art-Net on: localhost, all, an adapter
                        name (en0) or a local IP (default localhost)
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

let wledUrl = args.wled ?? process.env.WLED_URL;
if (!wledUrl) {
  fail('missing WLED address: pass --wled <url> or set WLED_URL (see --help)');
}
if (!/^https?:\/\//i.test(wledUrl)) {
  wledUrl = `http://${wledUrl}`;
}
try {
  new URL(wledUrl);
} catch {
  fail(`invalid WLED address "${wledUrl}"`);
}
let listenAddress;
try {
  listenAddress = resolveInterfaceAddress(args.interface);
} catch (err) {
  fail(err.message);
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

const wled = new WledController({ url: wledUrl, rate, transition });
wled.on('sent', (color) => {
  if (args.verbose) {
    const hex = [color.r, color.g, color.b].map((v) => v.toString(16).padStart(2, '0')).join('');
    console.log(`-> #${hex}${color.bri !== undefined ? ` bri ${color.bri}` : ''}`);
  }
});
wled.on('error', (err) => {
  console.error(`WLED update failed: ${err.message}`);
});

const receiver = new ArtnetReceiver({ address: listenAddress, universe });
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
  fail(`could not listen on ${args.interface} ${listenAddress}:${ARTNET_PORT}: ${err.message}`);
}
const map = `${useIntensity ? `I${channels.intensity} ` : ''}R${channels.red} G${channels.green} B${channels.blue}`;
console.log(`Listening on ${args.interface} ${listenAddress}:${ARTNET_PORT}, universe ${universe}, channels ${map}, max ${rate} Hz -> ${wledUrl}`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    receiver.stop();
    wled.stop();
    process.exit(0);
  });
}
