const DEFAULT_SETTINGS = {
  fontFamily: 'default',
  fontSize: 13,
  accent: '#2563eb',
  openWebUIEnabled: true,
  openWebUIModel: '',
  saveHistory: true,
};

const NUMERIC = new Set(['fontSize']);
const UNITS = { fontSize: 'px' };

const fields = Object.keys(DEFAULT_SETTINGS).map((key) => ({ key, el: document.getElementById(key) }));
const status = document.getElementById('status');

let statusTimer;
function flash(message) {
  status.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { status.textContent = ''; }, 1600);
}

function syncOutputs(values) {
  Object.entries(UNITS).forEach(([key, unit]) => {
    const out = document.getElementById(`${key}Out`);
    if (out) out.textContent = `${values[key]}${unit}`;
  });
}

function render(values) {
  fields.forEach(({ key, el }) => {
    if (!el) return;
    if (el.type === 'checkbox') el.checked = Boolean(values[key]);
    else el.value = values[key];
  });
  syncOutputs(values);
}

function collect() {
  const values = {};
  fields.forEach(({ key, el }) => {
    if (!el) return;
    if (el.type === 'checkbox') values[key] = el.checked;
    else values[key] = NUMERIC.has(key) ? Number(el.value) : el.value;
  });
  return values;
}

function persist() {
  const values = collect();
  syncOutputs(values);
  chrome.storage.sync.set(values, () => flash('Saved'));
}

fields.forEach(({ el }) => {
  if (!el) return;
  el.addEventListener('input', persist);
  el.addEventListener('change', persist);
});

document.getElementById('reset').addEventListener('click', () => {
  render(DEFAULT_SETTINGS);
  chrome.storage.sync.set(DEFAULT_SETTINGS, () => flash('Reset'));
});

function refreshHistoryCount() {
  const label = document.getElementById('historyCount');
  chrome.storage.local.get(null, (all) => {
    const entries = Object.entries(all)
      .filter(([key]) => key.startsWith('probe:'))
      .reduce((total, [, list]) => total + (Array.isArray(list) ? list.length : 0), 0);
    label.textContent = entries ? `${entries} saved` : 'Nothing saved';
  });
}

document.getElementById('clearHistory').addEventListener('click', () => {
  chrome.storage.local.get(null, (all) => {
    const keys = Object.keys(all).filter((key) => key.startsWith('probe:'));
    chrome.storage.local.remove(keys, () => {
      refreshHistoryCount();
      flash('History cleared');
    });
  });
});

chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => render({ ...DEFAULT_SETTINGS, ...stored }));
refreshHistoryCount();
