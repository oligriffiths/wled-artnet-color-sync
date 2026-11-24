// Renderer: wires the two panels to the main process through window.bridge (see preload.cjs).
const api = window.bridge;
const $ = (id) => document.getElementById(id);

const el = {
  iface: $('iface'),
  universe: $('universe'),
  chIntensity: $('ch-intensity'),
  chRed: $('ch-red'),
  chGreen: $('ch-green'),
  chBlue: $('ch-blue'),
  channelError: $('channel-error'),
  artnetStatus: $('artnet-status'),
  swatch: $('swatch'),
  vIntensity: $('v-intensity'),
  vRed: $('v-red'),
  vGreen: $('v-green'),
  vBlue: $('v-blue'),
  vHex: $('v-hex'),
  grid: $('grid'),
  device: $('device'),
  rescan: $('rescan'),
  manualIp: $('manual-ip'),
  includeIntensity: $('include-intensity'),
  intensityHint: $('intensity-hint'),
  rate: $('rate'),
  autoStart: $('auto-start'),
  start: $('start'),
  wledStatus: $('wled-status'),
  sentSwatch: $('sent-swatch'),
  sendTarget: $('send-target'),
  sendLast: $('send-last'),
  wledError: $('wled-error'),
};

// ---- Settings (per-machine convenience; the app works without them) ---------

const DEFAULTS = {
  iface: 'localhost',
  universe: 0,
  channels: { intensity: 1, red: 2, green: 3, blue: 4 },
  device: '',
  manualIp: '',
  includeIntensity: true,
  rate: 5,
  autoStart: false,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('settings') ?? '{}');
    return { ...DEFAULTS, ...saved, channels: { ...DEFAULTS.channels, ...saved.channels } };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem('settings', JSON.stringify(readForm()));
  } catch {
    // Storage unavailable; settings just won't persist.
  }
}

// ---- State ------------------------------------------------------------------

const settings = loadSettings();
let devices = [];
let sending = false;
let lastFrame = null;
let lastFrameAt = 0;
const cells = [];

// ---- Helpers ----------------------------------------------------------------

function hex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function intValue(input, min, max) {
  const n = Number(input.value);
  const valid = input.value !== '' && Number.isInteger(n) && n >= min && n <= max;
  input.classList.toggle('is-danger', !valid);
  return valid ? n : null;
}

function readChannels() {
  const channels = {
    intensity: intValue(el.chIntensity, 0, 512),
    red: intValue(el.chRed, 1, 512),
    green: intValue(el.chGreen, 1, 512),
    blue: intValue(el.chBlue, 1, 512),
  };
  const invalid = Object.values(channels).some((v) => v === null);
  el.channelError.hidden = !invalid;
  el.channelError.textContent = invalid ? 'Channels must be 1–512 (intensity 0 = none).' : '';
  return invalid ? null : channels;
}

function readForm() {
  return {
    iface: el.iface.value,
    universe: Number(el.universe.value),
    channels: {
      intensity: Number(el.chIntensity.value),
      red: Number(el.chRed.value),
      green: Number(el.chGreen.value),
      blue: Number(el.chBlue.value),
    },
    device: el.device.value,
    manualIp: el.manualIp.value.trim(),
    includeIntensity: el.includeIntensity.checked,
    rate: Number(el.rate.value),
    autoStart: el.autoStart.checked,
  };
}

function setStatus(node, text, level) {
  node.textContent = text;
  const tagClass = { ok: 'is-success', warn: 'is-warning', bad: 'is-danger' }[level] ?? '';
  node.className = `tag ${tagClass}`;
}

function showError(node, message) {
  node.hidden = !message;
  node.textContent = message ?? '';
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
    }, ms);
  };
}

// ---- Art-Net panel ------------------------------------------------------------

function buildGrid() {
  const fragment = document.createDocumentFragment();
  for (let ch = 1; ch <= 512; ch++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.title = `Channel ${ch}: –`;
    cells.push(cell);
    fragment.append(cell);
  }
  el.grid.append(fragment);
}

function markMappedCells() {
  const channels = readChannels();
  for (const cell of cells) {
    cell.classList.remove('mapped', 'mapped-r', 'mapped-g', 'mapped-b');
  }
  if (!channels) {
    return;
  }
  const marks = [
    [channels.intensity, 'mapped'],
    [channels.red, 'mapped-r'],
    [channels.green, 'mapped-g'],
    [channels.blue, 'mapped-b'],
  ];
  for (const [ch, cls] of marks) {
    if (ch > 0) {
      cells[ch - 1].classList.add('mapped', cls);
    }
  }
}

function renderFrame() {
  const channels = readChannels();
  if (!lastFrame || !channels) {
    el.vIntensity.textContent = '–';
    el.vRed.textContent = '–';
    el.vGreen.textContent = '–';
    el.vBlue.textContent = '–';
    el.vHex.textContent = '–';
    el.swatch.style.backgroundColor = '#000';
    return;
  }
  const data = lastFrame.data;
  const at = (ch) => (ch > 0 && ch <= data.length ? data[ch - 1] : 0);
  const r = at(channels.red);
  const g = at(channels.green);
  const b = at(channels.blue);
  const i = channels.intensity > 0 ? at(channels.intensity) : null;
  el.vIntensity.textContent = i === null ? 'off' : String(i);
  el.vRed.textContent = String(r);
  el.vGreen.textContent = String(g);
  el.vBlue.textContent = String(b);
  el.vHex.textContent = hex(r, g, b);
  // Show what the fixture would look like: color scaled by intensity.
  const scale = i === null ? 1 : i / 255;
  el.swatch.style.backgroundColor = `rgb(${Math.round(r * scale)} ${Math.round(g * scale)} ${Math.round(b * scale)})`;

  for (let ch = 0; ch < 512; ch++) {
    const v = ch < data.length ? data[ch] : 0;
    const cell = cells[ch];
    cell.style.setProperty('--level', (v / 255).toFixed(3));
    cell.title = `Channel ${ch + 1}: ${ch < data.length ? v : '–'}`;
  }
}

function updateArtnetStatus() {
  const now = Date.now();
  if (!lastFrame) {
    setStatus(el.artnetStatus, `Listening · no DMX on universe ${el.universe.value} yet`, 'warn');
    return;
  }
  const age = now - lastFrameAt;
  if (age > 2000) {
    setStatus(el.artnetStatus, `No DMX for ${Math.round(age / 1000)}s`, 'warn');
    return;
  }
  setStatus(el.artnetStatus, `Receiving from ${lastFrame.source} · ${lastFrame.fps} packets/s`, 'ok');
}

async function listen() {
  const universe = intValue(el.universe, 0, 32767);
  if (universe === null) {
    setStatus(el.artnetStatus, 'Universe must be 0–32767', 'bad');
    return;
  }
  lastFrame = null;
  renderFrame();
  setStatus(el.artnetStatus, 'Starting…');
  const res = await api.listen({ interface: el.iface.value, universe });
  if (!res.ok) {
    setStatus(el.artnetStatus, `Can't listen: ${res.error}`, 'bad');
    return;
  }
  updateArtnetStatus();
}

const relisten = debounce(() => {
  saveSettings();
  listen();
}, 300);

function onChannelsChanged() {
  markMappedCells();
  renderFrame();
  updateIntensityCheckbox();
  saveSettings();
  restartIfSending();
}

// ---- WLED panel ---------------------------------------------------------------

function renderDevices() {
  const selected = el.device.value || settings.device;
  el.device.replaceChildren();
  const placeholder = new Option(devices.length ? 'Choose a controller…' : 'No controllers found yet', '');
  el.device.append(placeholder);
  for (const d of devices) {
    el.device.append(new Option(`${d.name} (${d.address})`, d.url));
  }
  // Keep a saved selection visible even before it is rediscovered.
  if (selected && !devices.some((d) => d.url === selected)) {
    el.device.append(new Option(`${selected} (not seen yet)`, selected));
  }
  el.device.value = selected;
  const count = devices.length;
  setStatus(el.wledStatus, count ? `${count} controller${count === 1 ? '' : 's'} found` : 'Searching…', count ? 'ok' : 'warn');
}

function updateIntensityCheckbox() {
  const channel = Number(el.chIntensity.value);
  const available = Number.isInteger(channel) && channel > 0;
  el.includeIntensity.disabled = !available;
  el.intensityHint.hidden = available;
}

function targetUrl() {
  return el.manualIp.value.trim() || el.device.value;
}

function sendConfig() {
  const channels = readChannels();
  if (!channels) {
    return { error: 'Fix the DMX channel numbers first.' };
  }
  const rate = intValue(el.rate, 1, 60);
  if (rate === null) {
    return { error: 'Update rate must be 1–60 per second.' };
  }
  const url = targetUrl();
  if (!url) {
    return { error: 'Choose a WLED controller or enter its IP address.' };
  }
  return {
    config: {
      url,
      channels,
      includeIntensity: el.includeIntensity.checked && !el.includeIntensity.disabled,
      rate,
    },
  };
}

async function startSending() {
  const { config, error } = sendConfig();
  if (error) {
    showError(el.wledError, error);
    return false;
  }
  const res = await api.startSending(config);
  if (!res.ok) {
    showError(el.wledError, res.error);
    return false;
  }
  showError(el.wledError, null);
  sending = true;
  el.sendTarget.textContent = `Sending to ${res.value.url}`;
  el.sendLast.textContent = 'Waiting for a color change…';
  renderStartButton();
  return true;
}

async function stopSending() {
  await api.stopSending();
  sending = false;
  el.sendTarget.textContent = 'Not sending';
  el.sendLast.textContent = 'Updates go out only when the color changes.';
  renderStartButton();
}

function renderStartButton() {
  el.start.textContent = sending ? 'Stop sending' : 'Start sending';
  el.start.classList.toggle('is-primary', !sending);
  el.start.classList.toggle('is-danger', sending);
}

const restartIfSending = debounce(() => {
  if (sending) {
    startSending();
  }
}, 300);

function onWledSettingsChanged() {
  saveSettings();
  restartIfSending();
}

// ---- Wiring -------------------------------------------------------------------

async function init() {
  buildGrid();

  el.universe.value = settings.universe;
  el.chIntensity.value = settings.channels.intensity;
  el.chRed.value = settings.channels.red;
  el.chGreen.value = settings.channels.green;
  el.chBlue.value = settings.channels.blue;
  el.manualIp.value = settings.manualIp;
  el.includeIntensity.checked = settings.includeIntensity;
  el.rate.value = settings.rate;
  el.autoStart.checked = settings.autoStart;

  const res = await api.listInterfaces();
  const adapters = res.ok ? res.value : [{ id: 'localhost', label: 'localhost (127.0.0.1)' }];
  for (const a of adapters) {
    el.iface.append(new Option(a.label, a.id));
  }
  el.iface.value = adapters.some((a) => a.id === settings.iface) ? settings.iface : 'localhost';

  renderDevices();
  markMappedCells();
  updateIntensityCheckbox();
  renderStartButton();

  el.iface.addEventListener('change', relisten);
  el.universe.addEventListener('input', relisten);
  for (const input of [el.chIntensity, el.chRed, el.chGreen, el.chBlue]) {
    input.addEventListener('input', onChannelsChanged);
  }
  el.device.addEventListener('change', onWledSettingsChanged);
  el.manualIp.addEventListener('input', onWledSettingsChanged);
  el.includeIntensity.addEventListener('change', onWledSettingsChanged);
  el.rate.addEventListener('input', onWledSettingsChanged);
  el.autoStart.addEventListener('change', saveSettings);
  el.rescan.addEventListener('click', () => {
    devices = [];
    renderDevices();
    api.rescanWled();
  });
  el.start.addEventListener('click', async () => {
    el.start.disabled = true;
    try {
      if (sending) {
        await stopSending();
      } else {
        await startSending();
      }
    } finally {
      el.start.disabled = false;
    }
  });

  api.onDmx((frame) => {
    lastFrame = frame;
    lastFrameAt = Date.now();
    renderFrame();
  });
  api.onArtnetError((message) => {
    setStatus(el.artnetStatus, `Error: ${message}`, 'bad');
  });
  api.onDevices((list) => {
    devices = list;
    renderDevices();
  });
  api.onWledError((message) => {
    showError(el.wledError, message);
  });
  api.onSent((color) => {
    showError(el.wledError, null);
    el.sentSwatch.style.backgroundColor = hex(color.r, color.g, color.b);
    const bri = color.bri === undefined ? '' : ` · brightness ${color.bri}`;
    el.sendLast.textContent = `Last sent ${hex(color.r, color.g, color.b)}${bri}`;
  });

  setInterval(updateArtnetStatus, 500);
  await listen();

  // A saved controller is used even before discovery sees it again; any problem shows in the WLED panel.
  if (settings.autoStart) {
    await startSending();
  }
}

init();
