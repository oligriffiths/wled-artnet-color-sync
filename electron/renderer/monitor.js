// DMX Monitor window: every channel value of one adapter + universe, for debugging.
const api = window.bridge;
const $ = (id) => document.getElementById(id);

const STALE_MS = 2000;
const COLUMNS = 32;

const el = {
  iface: $('m-iface'),
  universe: $('m-universe'),
  status: $('m-status'),
  mapped: $('m-mapped'),
  grid: $('m-grid'),
};

const state = {
  interfaces: [],
  mappings: [],
  latest: null, // { frame, at } for the selected adapter + universe
};
const cells = [];

function setTag(node, text, level) {
  const cls = { ok: 'is-success', warn: 'is-warning', bad: 'is-danger' }[level] ?? '';
  node.textContent = text;
  node.className = ['tag', 'ml-auto', cls].filter(Boolean).join(' ');
}

function selectedAddress() {
  return state.interfaces.find((i) => i.id === el.iface.value)?.address ?? null;
}

function selectedUniverse() {
  const n = Number(el.universe.value);
  return el.universe.value !== '' && Number.isInteger(n) && n >= 0 && n <= 32767 ? n : null;
}

function buildGrid() {
  const fragment = document.createDocumentFragment();
  for (let ch = 1; ch <= 512; ch++) {
    if ((ch - 1) % COLUMNS === 0) {
      const label = document.createElement('div');
      label.className = 'row-label';
      label.textContent = String(ch);
      fragment.append(label);
    }
    const cell = document.createElement('div');
    cell.className = 'mcell';
    cell.title = `Channel ${ch}`;
    cell.textContent = '–';
    cells.push(cell);
    fragment.append(cell);
  }
  el.grid.append(fragment);
}

/** Outlines the channels that mappings read on the selected adapter + universe. */
function markMapped() {
  for (const cell of cells) {
    cell.classList.remove('mapped', 'mapped-r', 'mapped-g', 'mapped-b');
  }
  const universe = selectedUniverse();
  const using = state.mappings.filter((m) => m.interface === el.iface.value && m.universe === universe);
  for (const m of using) {
    const marks = [
      [m.channels.intensity, 'mapped'],
      [m.channels.red, 'mapped-r'],
      [m.channels.green, 'mapped-g'],
      [m.channels.blue, 'mapped-b'],
    ];
    for (const [ch, cls] of marks) {
      if (ch > 0 && ch <= 512) {
        cells[ch - 1].classList.add('mapped', cls);
      }
    }
  }
  const names = using.map((m) => m.name || `Universe ${m.universe} mapping`);
  el.mapped.textContent = names.length
    ? `Outlined channels are read by: ${names.join(', ')}`
    : 'No mapping reads this universe on this adapter.';
}

function render() {
  const entry = state.latest;
  const fresh = entry && Date.now() - entry.at <= STALE_MS;
  if (!selectedAddress()) {
    setTag(el.status, 'Adapter not available', 'bad');
  } else if (selectedUniverse() === null) {
    setTag(el.status, 'Universe must be 0–32767', 'bad');
  } else if (!entry) {
    setTag(el.status, 'No DMX on this universe yet', 'warn');
  } else if (!fresh) {
    setTag(el.status, `No DMX for ${Math.round((Date.now() - entry.at) / 1000)}s (showing last values)`, 'warn');
  } else {
    setTag(el.status, `${entry.frame.fps} packets/s from ${entry.frame.source} · ${entry.frame.data.length} channels`, 'ok');
  }

  const data = entry?.frame.data ?? [];
  for (let i = 0; i < 512; i++) {
    const has = i < data.length;
    const v = has ? data[i] : 0;
    const text = has ? String(v) : '–';
    const cell = cells[i];
    if (cell.textContent !== text) {
      cell.textContent = text;
      cell.style.setProperty('--level', (v / 255).toFixed(3));
      cell.classList.toggle('bright', v > 150);
      cell.title = `Channel ${i + 1}: ${text}`;
    }
  }
}

function fillInterfaces(selected) {
  el.iface.replaceChildren();
  for (const i of state.interfaces) {
    el.iface.append(new Option(i.label, i.id));
  }
  if (selected && !state.interfaces.some((i) => i.id === selected)) {
    el.iface.append(new Option(`${selected} (not available)`, selected));
  }
  el.iface.value = selected;
}

function saveSelection() {
  try {
    localStorage.setItem('monitor', JSON.stringify({ interface: el.iface.value, universe: el.universe.value }));
  } catch {
    // Storage unavailable; the selection just won't persist.
  }
}

function loadSelection() {
  const params = new URLSearchParams(location.search);
  if (params.get('interface')) {
    return { interface: params.get('interface'), universe: params.get('universe') ?? '0' };
  }
  try {
    const saved = JSON.parse(localStorage.getItem('monitor') ?? 'null');
    if (saved) {
      return saved;
    }
  } catch {
    // Fall through to the default.
  }
  return { interface: 'localhost', universe: '0' };
}

/** Switches to an adapter + universe and starts listening on that adapter. */
function select({ interface: iface, universe }) {
  fillInterfaces(iface);
  el.universe.value = universe;
  onSelectionChanged();
}

function onSelectionChanged() {
  state.latest = null;
  saveSelection();
  markMapped();
  render();
  api.setPreview(el.iface.value);
}

async function init() {
  buildGrid();
  const res = await api.getState();
  if (res.ok) {
    state.interfaces = res.value.interfaces;
    state.mappings = res.value.config.mappings;
  }
  select(loadSelection());

  el.iface.addEventListener('change', onSelectionChanged);
  el.universe.addEventListener('input', onSelectionChanged);
  api.onMonitorSelect((selection) => {
    select({ interface: selection.interface, universe: String(selection.universe) });
  });
  api.onConfig((config) => {
    state.mappings = config.mappings;
    markMapped();
  });
  api.onFrames((frames) => {
    const address = selectedAddress();
    const universe = selectedUniverse();
    const frame = frames.find((f) => f.address === address && f.universe === universe);
    if (frame) {
      state.latest = { frame, at: Date.now() };
      render();
    }
  });
  // Notice DMX stopping even when no frames arrive.
  setInterval(render, 1000);
}

init();
