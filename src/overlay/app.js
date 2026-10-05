'use strict';
/* global api */
// UI only: recording, audio and files are handled by the Rust backend.

const $ = (id) => document.getElementById(id);

const HOTKEY_LABELS = { toggleOverlay: 'overlegg', toggleRecord: 'opptak', pause: 'pause', marker: 'markør' };

let settings = null;
let state = 'idle'; // idle | starting | recording | paused | stopping

// ---------------------------------------------------------------- utils

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
function fmtSize(b) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${(b / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
}
function prettyAccel(a) {
  return (a || '—').replace('Control', 'Ctrl').replace('CommandOrControl', 'Ctrl').replace('Super', 'Win');
}

function toast(msg, kind = 'info', ms = 7000, file = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  if (file) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => api.showFile(file));
  }
  $('toasts').append(el);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

const errText = (e) => (typeof e === 'string' ? e : e?.message || String(e));

// ---------------------------------------------------------------- settings UI

async function saveSetting(patch) {
  const r = await api.setSettings(patch);
  settings = r.settings;
  if (r.failedHotkeys?.length) {
    toast(`Kunne ikke registrere hurtigtast: ${r.failedHotkeys.map((k) => HOTKEY_LABELS[k]).join(', ')} — et annet program bruker den kanskje allerede.`, 'warn');
  }
  renderHints();
  return r;
}

function bindSetting(id, { type = 'value', parse = (v) => v, live } = {}) {
  const el = $(id);
  const read = () => (type === 'checked' ? el.checked : parse(el.value));
  el[type] = settings[id];
  el.addEventListener('change', async () => {
    await saveSetting({ [id]: read() });
    live?.(read());
  });
  if (el.type === 'range') {
    const show = () => { $(`${id}Out`).textContent = `${Math.round(el.value * 100)}%`; };
    // Volumes apply live while dragging; the backend updates the running mixer.
    el.addEventListener('input', () => { show(); api.setSettings({ [id]: Number(el.value) }); });
    show();
  }
}

async function loadDisplays() {
  const sel = $('displayId');
  const displays = await api.listDisplays();
  sel.innerHTML = '';
  for (const d of displays) sel.append(new Option(d.name, d.displayId));
  const wanted = displays.find((d) => d.displayId === settings.displayId);
  sel.value = wanted ? wanted.displayId : (displays.find((d) => d.primary) || displays[0])?.displayId ?? '';
}

// Friendly names; the engine reports which encoders actually work on this PC.
const ENCODER_NAMES = {
  nvenc: 'NVIDIA (NVENC)',
  amf: 'AMD (AMF)',
  qsv: 'Intel (Quick Sync)',
  x264: 'Prosessor (x264) — tyngst',
};

async function loadEncoders() {
  const sel = $('encoder');
  const { auto, encoders } = await api.listEncoders();
  sel.innerHTML = '';
  sel.append(new Option(`Automatisk — ${ENCODER_NAMES[auto]}`, 'auto'));
  for (const e of encoders) {
    const opt = new Option(`${ENCODER_NAMES[e.id] || e.label}${e.available ? '' : ' — ikke funnet på denne PC-en'}`, e.id);
    opt.disabled = !e.available;
    sel.append(opt);
  }
  const current = [...sel.options].find((o) => o.value === settings.encoder && !o.disabled);
  sel.value = current ? current.value : 'auto';
}

async function loadMics() {
  const sel = $('micDeviceId');
  const mics = await api.listMics();
  sel.innerHTML = '';
  sel.append(new Option('Systemets standardmikrofon', 'default'));
  for (const m of mics) sel.append(new Option(m.name, m.id));
  sel.value = [...sel.options].some((o) => o.value === settings.micDeviceId) ? settings.micDeviceId : 'default';
}

function renderMode() {
  for (const b of $('modeSeg').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === settings.mode);
  }
  $('audioFmtLabel').textContent = settings.audioFormat.toUpperCase();
  $('micMeterRow').classList.toggle('off', !settings.captureMic);
  $('sysMeterRow').classList.toggle('off', !settings.captureSystemAudio);
}

function renderOutputDir() {
  const dir = settings.outputDir;
  const parts = dir.split(/[\\/]/).filter(Boolean);
  const short = dir.length > 48 && parts.length > 3 ? [parts[0], '…', ...parts.slice(-2)].join('\\') : dir;
  $('outputDir').textContent = short;
  $('outputDir').title = `${dir}\nKlikk for å åpne mappen`;
}

function renderHints() {
  const hk = settings.hotkeys;
  $('hints').innerHTML = '';
  for (const [label, acc] of [['overlegg', hk.toggleOverlay], ['opptak', hk.toggleRecord], ['pause', hk.pause], ['markør', hk.marker]]) {
    const span = document.createElement('span');
    const kbd = document.createElement('kbd');
    kbd.textContent = prettyAccel(acc);
    span.append(kbd, ` ${label}`);
    $('hints').append(span);
  }
  for (const input of document.querySelectorAll('.hotkey')) {
    if (!input.classList.contains('capturing')) input.value = prettyAccel(hk[input.dataset.key]);
  }
}

function setupHotkeyInputs() {
  const KEYMAP = {
    ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    '+': 'Plus', Escape: 'Escape', Enter: 'Return',
  };
  for (const input of document.querySelectorAll('.hotkey')) {
    input.addEventListener('focus', () => {
      input.classList.add('capturing');
      input.value = 'Trykk taster…';
      api.suspendHotkeys(true);
    });
    input.addEventListener('blur', () => {
      input.classList.remove('capturing');
      api.suspendHotkeys(false);
      renderHints();
    });
    input.addEventListener('keydown', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { input.blur(); return; }
      let key = KEYMAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
      if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
      if (/^Numpad\d$/.test(e.code)) key = `num${e.code.slice(6)}`;
      if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
      const mods = [];
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      if (!mods.length && !/^F\d{1,2}$/.test(key)) {
        input.classList.add('bad');
        input.value = 'Legg til Ctrl / Alt / Shift';
        setTimeout(() => input.classList.remove('bad'), 1200);
        return;
      }
      const accel = [...mods, key].join('+');
      input.classList.remove('capturing');
      input.value = prettyAccel(accel);
      // Re-enable first so the new combo gets registered when the setting is saved.
      await api.suspendHotkeys(false);
      await saveSetting({ hotkeys: { [input.dataset.key]: accel } });
      input.blur();
    });
  }
}

async function setupSettings() {
  settings = await api.getSettings();
  renderOutputDir();
  await loadDisplays();
  $('displayId').addEventListener('change', () => saveSetting({ displayId: $('displayId').value }));

  await loadEncoders();
  $('encoder').addEventListener('change', () => saveSetting({ encoder: $('encoder').value }));
  bindSetting('resolution');
  bindSetting('fps', { parse: Number });
  bindSetting('quality');
  bindSetting('captureSystemAudio', { type: 'checked', live: renderMode });
  bindSetting('systemVolume', { parse: Number });
  bindSetting('captureMic', { type: 'checked', live: renderMode });
  bindSetting('micVolume', { parse: Number });
  bindSetting('noiseSuppression', { type: 'checked' });
  bindSetting('audioFormat', { live: renderMode });
  bindSetting('showIndicator', { type: 'checked' });
  bindSetting('indicatorCorner');
  bindSetting('keepRaw', { type: 'checked' });

  await loadMics();
  $('micDeviceId').addEventListener('change', () => saveSetting({ micDeviceId: $('micDeviceId').value }));

  $('browseBtn').addEventListener('click', async () => {
    const dir = await api.pickFolder();
    if (!dir) return;
    await saveSetting({ outputDir: dir });
    renderOutputDir();
    refreshRecent();
    toast(state === 'idle' ? `Nye opptak lagres i ${dir}` : `Pågående opptak lagres fortsatt i den gamle mappen; nye opptak havner i ${dir}`, 'ok', 5000);
  });
  $('outputDir').addEventListener('click', () => api.openFolder());

  for (const b of $('modeSeg').querySelectorAll('button')) {
    b.addEventListener('click', async () => {
      if (state !== 'idle') return;
      await saveSetting({ mode: b.dataset.mode });
      renderMode();
    });
  }

  const autostart = $('autostart');
  autostart.checked = await api.getAutostart();
  autostart.addEventListener('change', async () => {
    try {
      autostart.checked = await api.setAutostart(autostart.checked);
    } catch (e) {
      autostart.checked = !autostart.checked;
      toast(errText(e), 'warn');
    }
  });

  setupHotkeyInputs();
  renderMode();
  renderHints();
}

// ---------------------------------------------------------------- recent list

async function refreshRecent() {
  const items = await api.listRecent();
  const ul = $('recentList');
  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = '<li class="empty">Ingen opptak ennå.</li>';
    return;
  }
  for (const it of items) {
    const li = document.createElement('li');
    li.title = 'Klikk for å vise i mappe · dobbeltklikk for å åpne';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = it.name.split('.').pop().toUpperCase();
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = fmtSize(it.size);
    li.append(tag, name, size);
    li.addEventListener('click', () => api.showFile(it.path));
    li.addEventListener('dblclick', () => api.openFile(it.path));
    ul.append(li);
  }
}

// ---------------------------------------------------------------- recording state (driven by the backend)

function render(rs) {
  const s = rs.state;
  const changed = s !== state;
  state = s;
  const active = s === 'recording' || s === 'paused';
  const recBtn = $('recBtn');
  recBtn.classList.toggle('stop', active || s === 'stopping');
  recBtn.disabled = s === 'starting' || s === 'stopping';
  $('recBtnText').textContent = {
    idle: 'Start opptak', starting: 'Starter…', recording: 'Stopp og lagre', paused: 'Stopp og lagre', stopping: 'Lagrer…',
  }[s];
  $('pauseBtn').disabled = !active;
  $('pauseBtn').classList.toggle('active', s === 'paused');
  $('markerBtn').disabled = !active;
  $('stateLabel').className = `state ${s === 'stopping' ? 'saving' : s}`;
  if (s !== 'stopping') {
    $('stateLabel').textContent = { idle: 'Klar', starting: 'Starter', recording: '● Tar opp', paused: 'Pauset' }[s];
  }
  $('lockable').disabled = s !== 'idle';
  $('modeSeg').classList.toggle('locked', s !== 'idle');
  $('progress').classList.toggle('hidden', s !== 'stopping');
  if (changed && s === 'stopping') $('progressBar').style.width = '0';

  if (active) {
    $('timer').textContent = fmtTime(rs.elapsedMs);
    $('metaLine').textContent = rs.file
      ? `${rs.file} · ${fmtSize(rs.bytes)}${rs.markers ? ` · ${rs.markers} markør${rs.markers > 1 ? 'er' : ''}` : ''}`
      : '';
  } else if (s === 'idle' || s === 'starting') {
    $('timer').textContent = '00:00:00';
    $('metaLine').textContent = '';
  }
}

async function run(action) {
  try {
    await action();
  } catch (e) {
    toast(errText(e), 'error', 12000);
  }
}

function toggleRecord() {
  if (state === 'idle') run(api.startRecording);
  else if (state === 'recording' || state === 'paused') run(api.stopRecording);
}

// ---------------------------------------------------------------- quit

// Quitting while recording needs a second click; the recording is saved before the app exits.
function setupQuitButton() {
  const btn = $('quitBtn');
  let armTimer = null;
  btn.addEventListener('click', () => {
    const recording = state === 'recording' || state === 'paused';
    if (recording && !btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.title = 'Klikk igjen for å avslutte';
      toast('Et opptak pågår. Klikk av-knappen igjen for å lagre opptaket og avslutte.', 'warn', 4000);
      armTimer = setTimeout(() => {
        btn.classList.remove('armed');
        btn.title = 'Avslutt Intervjueren';
      }, 4000);
      return;
    }
    clearTimeout(armTimer);
    if (recording) toast('Lagrer opptaket og avslutter…', 'info', 0);
    api.quitApp();
  });
}

// ---------------------------------------------------------------- wiring

function setupEvents() {
  $('recBtn').addEventListener('click', toggleRecord);
  $('pauseBtn').addEventListener('click', () => run(api.togglePause));
  $('markerBtn').addEventListener('click', () => run(api.addMarker));
  $('minBtn').addEventListener('click', () => api.hideOverlay());
  setupQuitButton();
  $('openFolderBtn').addEventListener('click', () => api.openFolder());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.classList?.contains('hotkey')) api.hideOverlay();
  });
  // An overlay has no use for the browser context menu.
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  api.on('rec:state', render);
  api.on('toast', (t) => toast(t.msg, t.kind, t.kind === 'error' ? 0 : t.file ? 12000 : 7000, t.file));
  api.on('recent:changed', refreshRecent);
  api.on('convert:progress', (pct) => {
    $('progressBar').style.width = `${pct}%`;
    $('stateLabel').textContent = `Lagrer ${pct} %`;
  });
  api.on('meters', ([mic, sys]) => {
    $('micMeter').style.width = `${mic * 100}%`;
    $('sysMeter').style.width = `${sys * 100}%`;
  });
  api.on('overlay:visibility', async (visible) => {
    if (visible) {
      refreshRecent();
      loadDisplays();
      for (const t of await api.takePendingToasts()) toast(t.msg, t.kind, 0, t.file);
    } else {
      $('micMeter').style.width = '0';
      $('sysMeter').style.width = '0';
    }
  });

  new ResizeObserver(() => api.resize($('panel').getBoundingClientRect().height)).observe($('panel'));
}

async function recoverCrashed() {
  const results = await api.runRecovery();
  for (const r of results) {
    if (r.ok) toast(`Gjenopprettet: ${r.file.split(/[\\/]/).pop()}`, 'ok', 0, r.file);
    else toast(`Kunne ikke gjenopprette ${r.name}: ${r.error}`, 'error', 0);
  }
  if (results.length) refreshRecent();
}

(async function init() {
  await setupSettings();
  setupEvents();
  render(await api.getState());
  refreshRecent();
  const failed = await api.takeStartupWarnings();
  if (failed.length) {
    toast(`Kunne ikke registrere hurtigtast: ${failed.map((k) => HOTKEY_LABELS[k]).join(', ')} — endre den i Innstillinger.`, 'warn', 0);
  }
  for (const t of await api.takePendingToasts()) toast(t.msg, t.kind, 0, t.file);
  recoverCrashed();
})();
