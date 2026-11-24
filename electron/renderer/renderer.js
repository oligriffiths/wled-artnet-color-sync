// Renderer: the mapping list and the add/edit dialog. Talks to the main process through window.bridge
// (see preload.cjs); the main process owns the mappings and the sockets.
const api = window.bridge;
const $ = (id) => document.getElementById(id);

const STALE_MS = 2000;

const state = {
  config: { autoStart: true, mappings: [] },
  interfaces: [],
  devices: [],
  status: {},
  frames: new Map(), // `${address}|${universe}` -> { frame, at }
};

// ---- Helpers ---------------------------------------------------------------

function hex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function setTag(node, text, level) {
  const cls = { ok: 'is-success', warn: 'is-warning', bad: 'is-danger', info: 'is-info' }[level] ?? '';
  const keep = [...node.classList].filter((c) => !c.startsWith('is-') && c !== 'tag');
  node.textContent = text;
  node.className = [...keep, 'tag', cls].filter(Boolean).join(' ');
}

function addressOf(interfaceId) {
  return state.interfaces.find((i) => i.id === interfaceId)?.address ?? null;
}

function interfaceLabel(interfaceId) {
  return state.interfaces.find((i) => i.id === interfaceId)?.label ?? `${interfaceId} (not available)`;
}

/** Latest DMX for an adapter + universe, or null when none has arrived recently. */
function liveFrame(interfaceId, universe) {
  const address = addressOf(interfaceId);
  const entry = address ? state.frames.get(`${address}|${universe}`) : null;
  if (!entry || Date.now() - entry.at > STALE_MS) {
    return null;
  }
  return entry.frame;
}

/** Reads the mapped channels from a frame. i is null when there is no intensity channel. */
function readColor(frame, channels) {
  const at = (ch) => (ch > 0 && ch <= frame.data.length ? frame.data[ch - 1] : 0);
  return {
    r: at(channels.red),
    g: at(channels.green),
    b: at(channels.blue),
    i: channels.intensity > 0 ? at(channels.intensity) : null,
  };
}

/** What the fixture would look like: the color scaled by intensity. */
function displayColor({ r, g, b, i }) {
  const scale = i === null ? 1 : i / 255;
  return `rgb(${Math.round(r * scale)} ${Math.round(g * scale)} ${Math.round(b * scale)})`;
}

function targetName(mapping) {
  const device = state.devices.find((d) => d.url === mapping.wled.url);
  if (device) {
    return device.name;
  }
  if (mapping.wled.name) {
    return mapping.wled.name;
  }
  return mapping.wled.url.replace(/^https?:\/\//, '') || 'No controller';
}

function mappingTitle(mapping) {
  return mapping.name || `Universe ${mapping.universe} → ${targetName(mapping)}`;
}

function channelSummary(channels) {
  const parts = [];
  if (channels.intensity > 0) {
    parts.push(`I${channels.intensity}`);
  }
  parts.push(`R${channels.red}`, `G${channels.green}`, `B${channels.blue}`);
  return `Channels ${parts.join(' ')}`;
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

// ---- Mapping list ------------------------------------------------------------

const cards = new Map(); // mapping id -> element refs

function renderList() {
  const list = $('mappings');
  list.replaceChildren();
  cards.clear();
  const { mappings } = state.config;
  $('empty').hidden = mappings.length > 0;
  $('auto-start').checked = state.config.autoStart;

  const template = $('mapping-template');
  for (const mapping of mappings) {
    const node = template.content.firstElementChild.cloneNode(true);
    const ref = {
      root: node,
      enabled: node.querySelector('.m-enabled'),
      name: node.querySelector('.m-name'),
      state: node.querySelector('.m-state'),
      source: node.querySelector('.m-source'),
      channels: node.querySelector('.m-channels'),
      rx: node.querySelector('.m-rx'),
      in: node.querySelector('.m-in'),
      target: node.querySelector('.m-target'),
      options: node.querySelector('.m-options'),
      tx: node.querySelector('.m-tx'),
      out: node.querySelector('.m-out'),
    };
    ref.enabled.checked = mapping.enabled;
    ref.enabled.addEventListener('change', async () => {
      const res = await api.setMappingEnabled(mapping.id, ref.enabled.checked);
      if (!res.ok) {
        ref.enabled.checked = !ref.enabled.checked;
      }
    });
    node.querySelector('.m-edit').addEventListener('click', () => {
      openEditor(mapping);
    });
    node.querySelector('.m-delete').addEventListener('click', () => {
      confirmDelete(mapping);
    });
    cards.set(mapping.id, ref);
    list.append(node);
  }
  renderSummary();
  updateCards();
}

function renderSummary() {
  const { mappings } = state.config;
  const enabled = mappings.filter((m) => m.enabled).length;
  const devices = state.devices.length;
  $('summary').textContent = [
    `${mappings.length} mapping${mappings.length === 1 ? '' : 's'} (${enabled} enabled)`,
    `${devices} WLED controller${devices === 1 ? '' : 's'} found`,
  ].join(' · ');
}

/** Refreshes the live parts of every card: colors, receive/send state and errors. */
function updateCards() {
  for (const mapping of state.config.mappings) {
    const ref = cards.get(mapping.id);
    if (!ref) {
      continue;
    }
    const status = state.status[mapping.id] ?? {};
    const frame = liveFrame(mapping.interface, mapping.universe);

    ref.name.textContent = mappingTitle(mapping);
    ref.name.title = mappingTitle(mapping);
    ref.source.textContent = interfaceLabel(mapping.interface);
    ref.channels.textContent = `Universe ${mapping.universe} · ${channelSummary(mapping.channels)}`;
    ref.target.textContent = targetName(mapping);
    ref.target.title = mapping.wled.url;
    const intensity = mapping.includeIntensity && mapping.channels.intensity > 0 ? 'brightness from intensity' : 'color only';
    ref.options.textContent = `${mapping.wled.url || '—'} · ${intensity} · max ${mapping.rate}/s`;

    if (frame) {
      const color = readColor(frame, mapping.channels);
      ref.in.style.backgroundColor = displayColor(color);
      ref.rx.textContent = `${hex(color.r, color.g, color.b)}${color.i === null ? '' : ` · I ${color.i}`} · ${frame.fps} packets/s from ${frame.source}`;
      ref.rx.className = 'm-rx is-size-7 truncate';
    } else {
      ref.in.style.backgroundColor = '#000';
      ref.rx.textContent = 'No DMX on this universe';
      ref.rx.className = 'm-rx is-size-7 truncate has-text-warning';
    }

    const sent = status.lastSent;
    ref.out.style.backgroundColor = sent ? hex(sent.r, sent.g, sent.b) : '#000';

    ref.root.classList.toggle('is-disabled', !mapping.enabled);
    ref.root.classList.toggle('is-running', Boolean(mapping.enabled && status.running && !status.error));
    ref.root.classList.toggle('is-error', Boolean(status.error));
    ref.tx.title = status.error ?? '';

    if (status.error) {
      setTag(ref.state, 'Error', 'bad');
      ref.tx.textContent = status.error;
      ref.tx.className = 'm-tx is-size-7 truncate has-text-danger';
    } else if (!mapping.enabled) {
      setTag(ref.state, 'Disabled');
      ref.tx.textContent = 'Not sending';
      ref.tx.className = 'm-tx is-size-7 truncate has-text-grey';
    } else if (!status.running) {
      setTag(ref.state, 'Starting…', 'info');
      ref.tx.textContent = '';
    } else {
      setTag(ref.state, frame ? 'Sending' : 'Waiting for DMX', frame ? 'ok' : 'warn');
      ref.tx.textContent = sent ? `Last sent ${hex(sent.r, sent.g, sent.b)}${sent.bri === undefined ? '' : ` · brightness ${sent.bri}`}` : 'Nothing sent yet';
      ref.tx.className = 'm-tx is-size-7 truncate';
    }
  }
}

// ---- Delete --------------------------------------------------------------------

let pendingDelete = null;

function confirmDelete(mapping) {
  pendingDelete = mapping;
  $('confirm-text').textContent = `"${mappingTitle(mapping)}" will stop sending and be removed.`;
  $('confirm').classList.add('is-active');
  $('confirm-cancel').focus();
}

function closeConfirm() {
  pendingDelete = null;
  $('confirm').classList.remove('is-active');
}

// ---- Editor ----------------------------------------------------------------------

const f = {
  title: $('editor-title'),
  name: $('f-name'),
  enabled: $('f-enabled'),
  iface: $('f-iface'),
  universe: $('f-universe'),
  chIntensity: $('f-ch-intensity'),
  chRed: $('f-ch-red'),
  chGreen: $('f-ch-green'),
  chBlue: $('f-ch-blue'),
  rx: $('f-rx'),
  swatch: $('f-swatch'),
  vI: $('f-v-i'),
  vR: $('f-v-r'),
  vG: $('f-v-g'),
  vB: $('f-v-b'),
  vHex: $('f-v-hex'),
  device: $('f-device'),
  rescan: $('f-rescan'),
  ip: $('f-ip'),
  includeIntensity: $('f-include-intensity'),
  intensityHint: $('f-intensity-hint'),
  rate: $('f-rate'),
  error: $('f-error'),
};
let editing = null; // the mapping being edited, {} for a new one, null when closed

function intValue(input, min, max) {
  const n = Number(input.value);
  const valid = input.value !== '' && Number.isInteger(n) && n >= min && n <= max;
  input.classList.toggle('is-danger', !valid);
  return valid ? n : null;
}

function editorChannels() {
  return {
    intensity: intValue(f.chIntensity, 0, 512),
    red: intValue(f.chRed, 1, 512),
    green: intValue(f.chGreen, 1, 512),
    blue: intValue(f.chBlue, 1, 512),
  };
}

function fillInterfaces(selected) {
  f.iface.replaceChildren();
  for (const i of state.interfaces) {
    f.iface.append(new Option(i.label, i.id));
  }
  if (selected && !state.interfaces.some((i) => i.id === selected)) {
    f.iface.append(new Option(`${selected} (not available)`, selected));
  }
  f.iface.value = selected;
}

function fillDevices(selected) {
  f.device.replaceChildren();
  f.device.append(new Option(state.devices.length ? 'Choose a controller…' : 'No controllers found yet', ''));
  for (const d of state.devices) {
    f.device.append(new Option(`${d.name} (${d.address})`, d.url));
  }
  if (selected && !state.devices.some((d) => d.url === selected)) {
    f.device.append(new Option(`${selected} (not seen yet)`, selected));
  }
  f.device.value = selected ?? '';
}

async function openEditor(mapping) {
  editing = mapping ?? {};
  const m = mapping ?? {
    name: '',
    enabled: true,
    interface: 'localhost',
    universe: 0,
    channels: { intensity: 1, red: 2, green: 3, blue: 4 },
    wled: { url: state.devices[0]?.url ?? '', name: '' },
    includeIntensity: true,
    rate: 5,
  };
  f.title.textContent = mapping ? 'Edit mapping' : 'Add mapping';
  f.name.value = m.name;
  f.enabled.checked = m.enabled;
  const res = await api.listInterfaces();
  if (res.ok) {
    state.interfaces = res.value;
  }
  fillInterfaces(m.interface);
  f.universe.value = m.universe;
  f.chIntensity.value = m.channels.intensity;
  f.chRed.value = m.channels.red;
  f.chGreen.value = m.channels.green;
  f.chBlue.value = m.channels.blue;
  // A saved URL with no device name and no discovered match was typed in by hand.
  const fromList = !m.wled.url || state.devices.some((d) => d.url === m.wled.url) || Boolean(m.wled.name);
  fillDevices(fromList ? m.wled.url : '');
  f.ip.value = fromList ? '' : m.wled.url.replace(/^https?:\/\//, '');
  f.device.disabled = f.ip.value !== '';
  f.includeIntensity.checked = m.includeIntensity;
  f.rate.value = m.rate;
  for (const input of [f.universe, f.chIntensity, f.chRed, f.chGreen, f.chBlue, f.rate]) {
    input.classList.remove('is-danger');
  }
  showEditorError(null);
  updateIntensityHint();
  updatePreview();
  $('editor').classList.add('is-active');
  f.name.focus();
  api.setPreview(f.iface.value);
}

function closeEditor() {
  editing = null;
  $('editor').classList.remove('is-active');
  api.setPreview(null);
}

function updateIntensityHint() {
  const channel = Number(f.chIntensity.value);
  const available = Number.isInteger(channel) && channel > 0;
  f.includeIntensity.disabled = !available;
  f.intensityHint.hidden = available;
}

function updatePreview() {
  if (!editing) {
    return;
  }
  const universe = Number(f.universe.value);
  const frame = Number.isInteger(universe) ? liveFrame(f.iface.value, universe) : null;
  const channels = editorChannels();
  const channelsValid = !Object.values(channels).includes(null);

  if (frame) {
    setTag(f.rx, `${frame.fps} packets/s from ${frame.source}`, 'ok');
  } else {
    setTag(f.rx, addressOf(f.iface.value) ? 'No DMX on this universe' : 'Adapter not available', 'warn');
  }

  if (!frame || !channelsValid) {
    for (const node of [f.vI, f.vR, f.vG, f.vB, f.vHex]) {
      node.textContent = '–';
    }
    f.swatch.style.backgroundColor = '#000';
  } else {
    const c = readColor(frame, channels);
    f.vI.textContent = c.i === null ? 'off' : String(c.i);
    f.vR.textContent = String(c.r);
    f.vG.textContent = String(c.g);
    f.vB.textContent = String(c.b);
    f.vHex.textContent = hex(c.r, c.g, c.b);
    f.swatch.style.backgroundColor = displayColor(c);
  }
}

function showEditorError(message) {
  f.error.textContent = message ?? '';
  f.error.hidden = !message;
}

async function saveEditor() {
  const universe = intValue(f.universe, 0, 32767);
  const channels = editorChannels();
  const rate = intValue(f.rate, 1, 60);
  if (universe === null) {
    showEditorError('Universe must be 0–32767.');
    return;
  }
  if (Object.values(channels).includes(null)) {
    showEditorError('Channels must be 1–512 (intensity 0 = none).');
    return;
  }
  if (rate === null) {
    showEditorError('Update rate must be 1–60 per second.');
    return;
  }
  const ip = f.ip.value.trim();
  const url = ip || f.device.value;
  if (!url) {
    showEditorError('Choose a WLED controller or enter its IP address.');
    return;
  }
  const device = ip ? null : state.devices.find((d) => d.url === url);
  let name = '';
  if (device) {
    name = device.name;
  } else if (!ip) {
    name = editing?.wled?.name ?? '';
  }
  const res = await api.saveMapping({
    id: editing?.id,
    name: f.name.value,
    enabled: f.enabled.checked,
    interface: f.iface.value,
    universe,
    channels,
    wled: { url, name },
    includeIntensity: f.includeIntensity.checked && !f.includeIntensity.disabled,
    rate,
  });
  if (!res.ok) {
    showEditorError(res.error);
    return;
  }
  closeEditor();
}

// ---- Wiring ------------------------------------------------------------------------

function wire() {
  $('add').addEventListener('click', () => {
    openEditor(null);
  });
  $('add-empty').addEventListener('click', () => {
    openEditor(null);
  });
  $('open-monitor').addEventListener('click', () => {
    api.openMonitor();
  });
  $('f-monitor').addEventListener('click', () => {
    const universe = intValue(f.universe, 0, 32767);
    api.openMonitor({ interface: f.iface.value, universe: universe ?? 0 });
  });
  $('auto-start').addEventListener('change', (event) => {
    api.setSettings({ autoStart: event.target.checked });
  });

  $('editor-close').addEventListener('click', closeEditor);
  $('editor-cancel').addEventListener('click', closeEditor);
  $('editor').querySelector('.modal-background').addEventListener('click', closeEditor);
  $('editor-save').addEventListener('click', saveEditor);
  f.iface.addEventListener('change', () => {
    api.setPreview(f.iface.value);
    updatePreview();
  });
  f.universe.addEventListener('input', debounce(updatePreview, 150));
  for (const input of [f.chIntensity, f.chRed, f.chGreen, f.chBlue]) {
    input.addEventListener('input', () => {
      updateIntensityHint();
      updatePreview();
    });
  }
  f.ip.addEventListener('input', () => {
    f.device.disabled = f.ip.value.trim() !== '';
  });
  f.rescan.addEventListener('click', () => {
    state.devices = [];
    fillDevices(f.device.value);
    api.rescanWled();
  });

  $('confirm-cancel').addEventListener('click', closeConfirm);
  $('confirm').querySelector('.modal-background').addEventListener('click', closeConfirm);
  $('confirm-delete').addEventListener('click', async () => {
    const mapping = pendingDelete;
    closeConfirm();
    if (mapping) {
      await api.deleteMapping(mapping.id);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    if ($('confirm').classList.contains('is-active')) {
      closeConfirm();
    } else if (editing) {
      closeEditor();
    }
  });

  api.onConfig((config) => {
    state.config = config;
    renderList();
  });
  api.onStatus((status) => {
    state.status = status;
    updateCards();
  });
  api.onDevices((devices) => {
    state.devices = devices;
    renderSummary();
    updateCards();
    if (editing) {
      fillDevices(f.device.value);
    }
  });
  api.onFrames((frames) => {
    const now = Date.now();
    for (const frame of frames) {
      state.frames.set(`${frame.address}|${frame.universe}`, { frame, at: now });
    }
    updateCards();
    updatePreview();
  });
  // Catch DMX going quiet even when no new frames arrive.
  setInterval(() => {
    updateCards();
    updatePreview();
  }, 1000);
}

async function init() {
  wire();
  const res = await api.getState();
  if (res.ok) {
    state.config = res.value.config;
    state.interfaces = res.value.interfaces;
    state.devices = res.value.devices;
    state.status = res.value.status;
  }
  renderList();
}

init();
