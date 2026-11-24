// Electron main process: owns the Art-Net socket, WLED discovery and the WLED sender,
// and streams state to the renderer over IPC.
import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtnetReceiver, listInterfaces, resolveInterfaceAddress } from '../lib/artnet-receiver.js';
import { Conductor } from '../lib/conductor.js';
import { WledController } from '../lib/wled-controller.js';
import { WledDiscovery } from '../lib/wled-discovery.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DMX_UI_FPS = 20;

let win = null;
let receiver = null;
let listenConfig = null;
let latestFrame = null;
let arrivals = []; // packet arrival times within the last second, for the incoming rate
let frameTimer = null;
let discovery = null;
let conductor = null;
let sendConfig = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// ---- Art-Net ---------------------------------------------------------------

async function listen({ interface: iface, universe }) {
  const address = resolveInterfaceAddress(iface);
  const next = new ArtnetReceiver({ address, universe });
  const wasSending = Boolean(conductor);
  stopSending();
  receiver?.stop();
  receiver = null;
  latestFrame = null;
  arrivals = [];
  next.on('dmx', ({ universe: u, source, data }) => {
    const now = Date.now();
    arrivals.push(now);
    while (arrivals[0] < now - 1000) {
      arrivals.shift();
    }
    latestFrame = { universe: u, source, data: Array.from(data), at: now, fps: arrivals.length };
  });
  next.on('error', (err) => {
    send('artnet:error', err.message);
  });
  await next.start();
  receiver = next;
  listenConfig = { interface: iface, universe, address };
  if (wasSending && sendConfig) {
    startSending(sendConfig);
  }
  return listenConfig;
}

// Coalesce DMX to a fixed UI rate; Art-Net can arrive at 40+ fps per universe.
function startFrameTimer() {
  frameTimer = setInterval(() => {
    if (latestFrame) {
      send('artnet:dmx', latestFrame);
      latestFrame = null;
    }
  }, 1000 / DMX_UI_FPS);
}

// ---- WLED ------------------------------------------------------------------

function startDiscovery() {
  discovery?.stop();
  discovery = new WledDiscovery();
  discovery.on('device', () => {
    send('wled:devices', discovery.found);
  });
  discovery.on('error', (err) => {
    send('wled:error', `discovery: ${err.message}`);
  });
  discovery.start();
  send('wled:devices', discovery.found);
}

function normalizeUrl(value) {
  let url = String(value ?? '').trim();
  if (!url) {
    throw new Error('choose a WLED controller or enter its IP address');
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  new URL(url);
  return url;
}

function startSending(config) {
  if (!receiver) {
    throw new Error('Art-Net is not listening');
  }
  stopSending();
  const url = normalizeUrl(config.url);
  const { channels, includeIntensity, rate } = config;
  const wled = new WledController({ url, rate: Number(rate) });
  conductor = new Conductor({
    receiver,
    wled,
    channels: { ...channels, intensity: includeIntensity ? channels.intensity : 0 },
  });
  conductor.on('sent', (color) => {
    send('send:sent', color);
  });
  conductor.on('error', (err) => {
    send(err.source === 'wled' ? 'wled:error' : 'artnet:error', err.message);
  });
  // The receiver is already started, so this only subscribes.
  conductor.start();
  sendConfig = { ...config, url };
  return sendConfig;
}

function stopSending() {
  conductor?.stop({ stopReceiver: false });
  conductor = null;
}

// ---- IPC -------------------------------------------------------------------

/** Wraps a handler so errors reach the renderer as { error } instead of a rejected invoke. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, arg) => {
    try {
      return { ok: true, value: await fn(arg) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

handle('artnet:interfaces', () => listInterfaces());
handle('artnet:listen', (config) => listen(config));
handle('wled:rescan', () => {
  startDiscovery();
});
handle('send:start', (config) => startSending(config));
handle('send:stop', () => {
  stopSending();
  sendConfig = null;
});

// ---- Window ----------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    title: 'Art-Net → WLED',
    backgroundColor: '#15171c',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('preload-error', (_event, preloadPath, err) => {
    console.error(`preload error in ${preloadPath}: ${err.stack ?? err}`);
  });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.error(`renderer ${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  win.loadFile(path.join(here, 'renderer', 'index.html'));

  // APP_SCREENSHOT=/path/file.png captures the window after a few seconds and quits (for testing).
  if (process.env.APP_SCREENSHOT) {
    setTimeout(async () => {
      const image = await win.webContents.capturePage();
      await writeFile(process.env.APP_SCREENSHOT, image.toPNG());
      app.quit();
    }, Number(process.env.APP_SCREENSHOT_DELAY ?? 5000));
  }
}

app.whenReady().then(() => {
  createWindow();
  startFrameTimer();
  startDiscovery();
});

app.on('window-all-closed', () => {
  clearInterval(frameTimer);
  stopSending();
  receiver?.stop();
  discovery?.stop();
  app.quit();
});
