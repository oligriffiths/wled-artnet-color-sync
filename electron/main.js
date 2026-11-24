// Electron main process: stores the mappings, runs them through the Engine, keeps WLED discovery going,
// and streams state to the renderer over IPC.
import { app, BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listInterfaces } from '../lib/artnet-receiver.js';
import { WledDiscovery } from '../lib/wled-discovery.js';
import { Engine } from './engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, 'assets', 'icon.png');

let win = null;
let monitor = null;
let discovery = null;
const engine = new Engine();
let config = { autoStart: true, mappings: [] };

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/** Sends to every open window (the main window and the DMX monitor). */
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send(channel, payload);
    }
  }
}

// ---- Config ----------------------------------------------------------------

function configPath() {
  return process.env.APP_CONFIG ?? path.join(app.getPath('userData'), 'config.json');
}

async function loadConfig() {
  try {
    const saved = JSON.parse(await readFile(configPath(), 'utf8'));
    config = {
      autoStart: saved.autoStart !== false,
      mappings: Array.isArray(saved.mappings) ? saved.mappings : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`could not read ${configPath()}: ${err.message}`);
    }
  }
  if (!config.autoStart) {
    // Mappings keep their settings but wait for the user to enable them.
    config.mappings = config.mappings.map((m) => ({ ...m, enabled: false }));
  }
}

async function saveConfig() {
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true });
  // Write then rename, so a crash never leaves a half-written config.
  await writeFile(`${file}.tmp`, JSON.stringify(config, null, 2));
  await rename(`${file}.tmp`, file);
}

async function commit() {
  await saveConfig();
  send('config:changed', config);
  await engine.apply(config.mappings);
  return config;
}

/** Keeps only known fields with sane types, so the config file stays predictable. */
function cleanMapping(input, existing) {
  const int = (v, fallback) => (Number.isInteger(Number(v)) && v !== '' && v !== null ? Number(v) : fallback);
  const channels = input.channels ?? {};
  return {
    id: existing?.id ?? randomUUID(),
    name: String(input.name ?? '').trim(),
    enabled: Boolean(input.enabled ?? existing?.enabled ?? true),
    interface: String(input.interface ?? 'localhost'),
    universe: int(input.universe, 0),
    channels: {
      intensity: int(channels.intensity, 0),
      red: int(channels.red, 1),
      green: int(channels.green, 2),
      blue: int(channels.blue, 3),
    },
    wled: {
      url: String(input.wled?.url ?? '').trim(),
      name: String(input.wled?.name ?? '').trim(),
    },
    includeIntensity: Boolean(input.includeIntensity),
    rate: int(input.rate, 5),
  };
}

// ---- WLED discovery --------------------------------------------------------

function startDiscovery() {
  discovery?.stop();
  discovery = new WledDiscovery();
  discovery.on('device', () => {
    send('wled:devices', discovery.found);
  });
  discovery.on('error', (err) => {
    console.error(`WLED discovery: ${err.message}`);
  });
  discovery.start();
  send('wled:devices', discovery.found);
}

// ---- IPC -------------------------------------------------------------------

/** Wraps a handler so errors reach the renderer as { ok: false, error } instead of a rejected invoke. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

handle('app:state', () => ({
  config,
  interfaces: listInterfaces(),
  devices: discovery?.found ?? [],
  status: engine.statuses,
}));
handle('artnet:interfaces', () => listInterfaces());
handle('wled:rescan', () => {
  startDiscovery();
});
// Each window keeps its own preview adapter, keyed by its webContents id.
ipcMain.handle('preview:set', async (event, interfaceId) => {
  try {
    await engine.setPreview(event.sender.id, interfaceId ?? null);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
handle('monitor:open', (selection) => {
  openMonitor(selection);
});
handle('settings:set', async (settings) => {
  config.autoStart = Boolean(settings.autoStart);
  await saveConfig();
  send('config:changed', config);
  return config;
});
handle('mapping:save', async (input) => {
  const index = config.mappings.findIndex((m) => m.id === input.id);
  const mapping = cleanMapping(input, config.mappings[index]);
  if (index >= 0) {
    config.mappings[index] = mapping;
  } else {
    config.mappings.push(mapping);
  }
  await commit();
  return mapping;
});
handle('mapping:delete', async (id) => {
  config.mappings = config.mappings.filter((m) => m.id !== id);
  return commit();
});
handle('mapping:enable', async (id, enabled) => {
  const mapping = config.mappings.find((m) => m.id === id);
  if (!mapping) {
    throw new Error('mapping not found');
  }
  mapping.enabled = Boolean(enabled);
  return commit();
});

engine.on('frames', (frames) => {
  broadcast('dmx:frames', frames);
});
engine.on('status', (status) => {
  send('mapping:status', status);
});

// ---- Windows ---------------------------------------------------------------

const webPreferences = {
  preload: path.join(here, 'preload.cjs'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
};

function forwardRendererErrors(w, label) {
  w.webContents.on('preload-error', (_event, preloadPath, err) => {
    console.error(`${label} preload error in ${preloadPath}: ${err.stack ?? err}`);
  });
  w.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.error(`${label} ${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
}

/**
 * Opens the DMX monitor (or focuses it), optionally switching it to an adapter and universe.
 * @param {{ interface?: string, universe?: number }} [selection]
 */
function openMonitor(selection) {
  if (monitor && !monitor.isDestroyed()) {
    if (selection) {
      monitor.webContents.send('monitor:select', selection);
    }
    monitor.show();
    monitor.focus();
    return;
  }
  monitor = new BrowserWindow({
    width: 1000,
    height: 640,
    minWidth: 700,
    minHeight: 420,
    title: 'DMX Monitor',
    backgroundColor: '#14161a',
    icon: ICON,
    webPreferences,
  });
  forwardRendererErrors(monitor, 'monitor');
  const contentsId = monitor.webContents.id;
  monitor.on('closed', () => {
    engine.setPreview(contentsId, null);
    monitor = null;
  });
  monitor.loadFile(path.join(here, 'renderer', 'monitor.html'), {
    query: selection ? { interface: selection.interface ?? '', universe: String(selection.universe ?? '') } : {},
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    title: 'Art-Net → WLED',
    backgroundColor: '#14161a',
    icon: ICON,
    webPreferences,
  });
  forwardRendererErrors(win, 'renderer');
  const contentsId = win.webContents.id;
  win.on('closed', () => {
    engine.setPreview(contentsId, null);
  });
  // Closing the main window quits the app, monitor included.
  win.on('close', () => {
    if (monitor && !monitor.isDestroyed()) {
      monitor.destroy();
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

app.whenReady().then(async () => {
  // Windows and Linux take the icon from each window; macOS shows the Dock icon, which an unpackaged
  // app has to set at runtime.
  if (process.platform === 'darwin') {
    app.dock?.setIcon(ICON);
  }
  await loadConfig();
  createWindow();
  startDiscovery();
  await engine.apply(config.mappings);
});

app.on('window-all-closed', () => {
  engine.close();
  discovery?.stop();
  app.quit();
});
