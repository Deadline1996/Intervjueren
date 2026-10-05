'use strict';
const {
  app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, dialog, shell, screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn, execFile } = require('child_process');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// ---------------------------------------------------------------- lean Chromium
// The UI is a small 2D panel, so software rendering is plenty and saves ~100 MB of GPU-process
// memory. Recording never touches Chromium (see engine/), so no capture or audio services needed.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', [
  'SpareRendererForSitePerProcess', // no pre-warmed spare renderer process
  'CalculateNativeWinOcclusion',
  'MediaRouter',
  'HardwareMediaKeyHandling',
].join(','));
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2'); // one process fewer
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=64 --lite-mode');

// ---------------------------------------------------------------- settings

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

// The app used to be called "FiveM Recorder"; carry its settings over after the rename.
const LEGACY_SETTINGS = path.join(app.getPath('appData'), 'FiveM Recorder', 'settings.json');
if (!fs.existsSync(SETTINGS_FILE) && fs.existsSync(LEGACY_SETTINGS)) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.copyFileSync(LEGACY_SETTINGS, SETTINGS_FILE);
  } catch { /* fall back to defaults */ }
}

const DEFAULTS = {
  outputDir: path.join(app.getPath('videos'), 'FiveM-intervjuer'),
  mode: 'video',                 // 'video' | 'audio'
  displayId: null,               // monitor index as the engine reports it (null = primary)
  resolution: '1080',            // 'native' | '1440' | '1080' | '720'
  fps: 30,
  quality: 'medium',             // 'low' | 'medium' | 'high'
  encoder: 'auto',               // 'auto' | 'nvenc' (NVIDIA) | 'amf' (AMD) | 'qsv' (Intel) | 'x264' (CPU)
  captureSystemAudio: true,      // game + voice chat (Windows loopback)
  captureMic: true,
  micDeviceId: 'default',        // device name, or 'default'
  micVolume: 1,
  systemVolume: 1,
  noiseSuppression: true,
  audioFormat: 'mp3',            // audio-only output: 'mp3' | 'm4a' | 'wav'
  keepRaw: false,
  showIndicator: true,
  indicatorCorner: 'top-right',  // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  hotkeys: {
    toggleOverlay: 'Alt+O',
    toggleRecord: 'Alt+R',
    pause: 'Alt+P',
    marker: 'Alt+M',
  },
};

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULTS, ...raw, hotkeys: { ...DEFAULTS.hotkeys, ...(raw.hotkeys || {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let settings = loadSettings();

// ---------------------------------------------------------------- state

const IDLE_STATE = { state: 'idle', elapsedMs: 0, bytes: 0, file: null, markers: 0 };

let overlay = null;
let overlayDestroyTimer = null;
let indicator = null;
let indicatorTimer = null;
let tray = null;
let quitting = false;
let recState = { ...IDLE_STATE };
let recoveryDone = false;
let hotkeysSuspended = false;
let startupWarnings = [];
let pendingToasts = [];
let displaysCache = [];

const alive = (win) => win && !win.isDestroyed();
const send = (win, channel, data) => {
  if (alive(win) && !win.webContents.isLoading()) win.webContents.send(channel, data);
};
const isRecording = () => recState.state === 'recording' || recState.state === 'paused';

function pad(n) { return String(n).padStart(2, '0'); }
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

const ASSETS = path.join(__dirname, 'assets');
const ICONS = {};
function icon(state) {
  const key = ['recording', 'paused'].includes(state) ? state : 'idle';
  // tray-<state>.png has a @2x sibling that Electron picks up automatically on high-DPI screens
  return (ICONS[key] ||= nativeImage.createFromPath(path.join(ASSETS, `tray-${key}.png`)));
}

function toast(kind, msg, file = null) {
  if (overlayVisible()) send(overlay, 'toast', { kind, msg, file });
  else if (kind !== 'info') pendingToasts = [...pendingToasts, { kind, msg, file }].slice(-5);
}

// ---------------------------------------------------------------- recording engine
// engine/ (Rust) does all capture: ffmpeg ddagrab → NVENC for video, WASAPI loopback + mic for
// audio. We talk to it with one JSON object per line.

const BIN = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'bin');
let engine = null;
let requestId = 0;
const pending = new Map();

function startEngine() {
  engine = spawn(path.join(BIN, 'intervjueren-engine.exe'), ['--ffmpeg', path.join(BIN, 'ffmpeg.exe')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const proc = engine;
  readline.createInterface({ input: proc.stdout }).on('line', onEngineLine);
  proc.on('error', (err) => toast('error', `Kunne ikke starte opptaksmotoren: ${err.message}`));
  proc.on('exit', () => {
    if (engine === proc) engine = null;
    for (const p of pending.values()) p.reject(new Error('Opptaksmotoren stoppet uventet.'));
    pending.clear();
    if (isRecording()) {
      toast('error', 'Opptaksmotoren stoppet uventet. Det som er tatt opp, gjenopprettes automatisk.');
      recoveryDone = false;
    }
    onState({ ...IDLE_STATE });
  });
}

function call(cmd, args = {}) {
  if (!engine) startEngine();
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    engine.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
  });
}

function onEngineLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (p) msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
    return;
  }
  switch (msg.event) {
    case 'state': onState(msg); break;
    case 'meters': send(overlay, 'meters', [msg.mic, msg.sys]); break;
    case 'progress':
      send(overlay, 'convert:progress', msg.pct);
      break;
    case 'toast': toast(msg.kind, msg.msg); break;
    default: break;
  }
}

function onState(s) {
  const { event, ...state } = s;
  const changed = state.state !== recState.state;
  recState = state;
  send(overlay, 'rec:state', state);
  updateTray();
  if (isRecording()) {
    const label = state.state === 'paused' ? 'PAUSE' : 'REC';
    setIndicator({ state: state.state, text: `${label} ${fmtTime(state.elapsedMs)}` });
  }
  if (changed && state.state === 'idle') {
    if (overlayVisible()) setMetering(true); // bring back the idle level meters
    else scheduleOverlayDestroy();
  }
}

function audioConfig() {
  return {
    mic: settings.captureMic ? settings.micDeviceId : null,
    loopback: settings.captureSystemAudio,
    noiseSuppression: settings.noiseSuppression,
    micGain: settings.micVolume,
    sysGain: settings.systemVolume,
  };
}

async function startRecording() {
  if (recState.state !== 'idle') return;
  const r = await call('start', {
    kind: settings.mode === 'audio' ? 'audio' : 'video',
    outDir: settings.outputDir,
    displayId: settings.displayId,
    resolution: settings.resolution,
    fps: Number(settings.fps) || 30,
    quality: settings.quality,
    audio: audioConfig(),
    audioFormat: settings.audioFormat,
    keepRaw: settings.keepRaw,
    encoder: settings.encoder === 'auto' ? null : settings.encoder,
  });
  for (const w of r.warnings || []) toast('warn', w);
  if (r.video) {
    const mbps = (r.video.bitrate / 1e6).toFixed(1).replace('.', ',');
    toast('info', `Tar opp ${r.video.width}×${r.video.height} · ${mbps} Mbps · ${r.video.encoder}`);
  }
}

async function stopRecording() {
  if (!isRecording()) return;
  setIndicator({ state: 'saving', text: 'Lagrer…' });
  try {
    const r = await call('stop');
    if (r?.file) {
      setIndicator({ state: 'saved', text: 'Lagret ✓' }, 2500);
      toast('ok', `Lagret ${path.basename(r.file)} — klikk for å vise`, r.file);
    } else {
      setIndicator(null);
    }
  } catch (err) {
    setIndicator({ state: 'error', text: 'Lagring feilet' }, 6000);
    toast('error', `Lagring feilet: ${err.message}`);
  }
  send(overlay, 'recent:changed');
  if (quitting) app.quit();
}

function toggleRecord() {
  const action = recState.state === 'idle' ? startRecording : isRecording() ? stopRecording : null;
  action?.().catch((err) => toast('error', err.message));
}

function togglePause() {
  if (!isRecording()) return Promise.resolve();
  return call(recState.state === 'paused' ? 'resume' : 'pause');
}

async function addMarker() {
  if (!isRecording()) return;
  const r = await call('marker');
  if (!r) return;
  toast('info', `Markør ${r.count} ved ${r.time}`);
  setIndicator({ state: recState.state, text: `Markør ${r.count} ved ${r.time}`, flash: true });
}

// Level meters run only while the overlay is on screen.
function setMetering(on) {
  call('meters', { on }).catch(() => {});
  if (recState.state === 'idle') {
    const wantPreview = on && (settings.captureMic || settings.captureSystemAudio);
    call('preview', { audio: wantPreview ? audioConfig() : null }).catch(() => {});
  }
}

// ---------------------------------------------------------------- windows
// Windows are created on demand and destroyed when not needed: an idle Intervjueren is just the
// tray icon plus a sleeping engine.

const PRELOAD = path.join(__dirname, 'preload.js');
const OVERLAY_WIDTH = 440;
const OVERLAY_KEEPALIVE_MS = 60_000; // reopening within a minute is instant

const overlayVisible = () => alive(overlay) && overlay.isVisible();

function createOverlay() {
  overlay = new BrowserWindow({
    width: OVERLAY_WIDTH, height: 640,
    show: false, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
    maximizable: false, minimizable: false, hasShadow: false,
    title: 'Intervjueren',
    icon: path.join(ASSETS, 'app.png'),
    webPreferences: { preload: PRELOAD, contextIsolation: true, spellcheck: false, backgroundThrottling: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setContentProtection(true); // keep the overlay itself out of recordings
  overlay.on('close', (e) => {
    if (!quitting) { e.preventDefault(); hideOverlay(); }
  });
  overlay.on('closed', () => { overlay = null; });
  overlay.loadFile(path.join(__dirname, 'overlay', 'index.html'));
  return new Promise((resolve) => overlay.once('ready-to-show', resolve));
}

async function showOverlay() {
  clearTimeout(overlayDestroyTimer);
  if (!alive(overlay)) await createOverlay();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [w] = overlay.getSize();
  overlay.setPosition(Math.round(area.x + (area.width - w) / 2), area.y + 40);
  overlay.show();
  overlay.focus();
  send(overlay, 'overlay:visibility', true);
  setMetering(true);
}

function hideOverlay() {
  if (!alive(overlay)) return;
  overlay.hide();
  send(overlay, 'overlay:visibility', false);
  setMetering(false);
  scheduleOverlayDestroy();
}

function scheduleOverlayDestroy() {
  clearTimeout(overlayDestroyTimer);
  overlayDestroyTimer = setTimeout(() => {
    if (alive(overlay) && !overlay.isVisible()) overlay.destroy();
  }, OVERLAY_KEEPALIVE_MS);
}

function toggleOverlay() {
  if (overlayVisible()) hideOverlay(); else showOverlay();
}

function createIndicator() {
  indicator = new BrowserWindow({
    width: 190, height: 44,
    show: false, frame: false, transparent: true, resizable: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, spellcheck: false },
  });
  indicator.setAlwaysOnTop(true, 'screen-saver');
  indicator.setIgnoreMouseEvents(true);
  indicator.setContentProtection(true);
  indicator.on('closed', () => { indicator = null; });
  indicator.loadFile(path.join(__dirname, 'indicator', 'index.html'));
  return indicator;
}

function positionIndicator() {
  if (!alive(indicator)) return;
  // The engine reports monitors in physical pixels; convert to Electron's DIP coordinates.
  const d = displaysCache.find((x) => x.displayId === String(settings.displayId)) || displaysCache.find((x) => x.primary);
  const area = d
    ? screen.getDisplayNearestPoint(screen.screenToDipPoint({ x: d.rect[0] + d.rect[2] / 2, y: d.rect[1] + d.rect[3] / 2 })).workArea
    : screen.getPrimaryDisplay().workArea;
  const [w, h] = indicator.getSize();
  const m = 14;
  const corner = settings.indicatorCorner || 'top-right';
  const x = corner.endsWith('left') ? area.x + m : area.x + area.width - w - m;
  const y = corner.startsWith('top') ? area.y + m : area.y + area.height - h - m;
  indicator.setPosition(Math.round(x), Math.round(y));
}

function setIndicator(data, autoHideMs = 0) {
  clearTimeout(indicatorTimer);
  if (!data || !settings.showIndicator) {
    if (alive(indicator)) indicator.destroy();
    return;
  }
  if (!alive(indicator)) {
    createIndicator();
    indicator.webContents.once('did-finish-load', () => {
      positionIndicator();
      send(indicator, 'indicator:update', data);
      indicator.showInactive();
    });
  } else {
    send(indicator, 'indicator:update', data);
  }
  if (autoHideMs) indicatorTimer = setTimeout(() => setIndicator(null), autoHideMs);
}

// ---------------------------------------------------------------- tray

function updateTray() {
  if (!tray) return;
  tray.setImage(icon(recState.state));
  const label = recState.state === 'recording' ? `Tar opp ${fmtTime(recState.elapsedMs)}`
    : recState.state === 'paused' ? `Pauset ${fmtTime(recState.elapsedMs)}`
      : recState.state === 'stopping' ? 'Lagrer…' : 'Inaktiv';
  tray.setToolTip(`Intervjueren — ${label}`);
}

function buildTrayMenu() {
  const hk = settings.hotkeys;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Vis / skjul overlegg', accelerator: hk.toggleOverlay, click: toggleOverlay },
    { label: 'Start / stopp opptak', accelerator: hk.toggleRecord, click: toggleRecord },
    { type: 'separator' },
    { label: 'Åpne opptaksmappe', click: () => openOutputDir() },
    { type: 'separator' },
    { label: 'Avslutt', click: requestQuit },
  ]));
}

function createTray() {
  tray = new Tray(icon('idle'));
  tray.on('click', toggleOverlay);
  buildTrayMenu();
  updateTray();
}

// ---------------------------------------------------------------- hotkeys

function registerHotkeys() {
  globalShortcut.unregisterAll();
  if (hotkeysSuspended) return [];
  const actions = {
    toggleOverlay,
    toggleRecord,
    pause: () => togglePause().catch((err) => toast('error', err.message)),
    marker: () => addMarker().catch((err) => toast('error', err.message)),
  };
  const failed = [];
  for (const [name, fn] of Object.entries(actions)) {
    const acc = settings.hotkeys[name];
    if (!acc) continue;
    try {
      if (!globalShortcut.register(acc, fn)) failed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

// ---------------------------------------------------------------- IPC
// Every handler answers { ok, data } / { ok: false, error } so the UI gets clean messages.

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

// Start with Windows: the same HKCU Run entry the installer's checkbox writes.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'Intervjueren';
const reg = (...args) => new Promise((resolve) => {
  execFile('reg.exe', args, { windowsHide: true }, (err) => resolve(!err));
});

function getAutostart() {
  return reg('query', RUN_KEY, '/v', RUN_NAME);
}

async function setAutostart(on) {
  if (!app.isPackaged) throw new Error('Oppstart med Windows kan bare settes i den installerte versjonen.');
  const ok = on
    ? await reg('add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', `"${process.execPath}" --hidden`, '/f')
    : await reg('delete', RUN_KEY, '/v', RUN_NAME, '/f');
  if (!ok && on) throw new Error('Kunne ikke slå på oppstart med Windows.');
  return getAutostart();
}

function openOutputDir() {
  fs.mkdirSync(settings.outputDir, { recursive: true });
  shell.openPath(settings.outputDir);
}

handle('settings:get', () => settings);

handle('settings:set', (patch) => {
  const before = settings;
  settings = { ...settings, ...patch, hotkeys: { ...settings.hotkeys, ...(patch.hotkeys || {}) } };
  saveSettings();
  let failedHotkeys = [];
  if (patch.hotkeys && JSON.stringify(before.hotkeys) !== JSON.stringify(settings.hotkeys)) {
    failedHotkeys = registerHotkeys();
    buildTrayMenu();
  }
  if ('micVolume' in patch || 'systemVolume' in patch) {
    call('gains', { mic: settings.micVolume, sys: settings.systemVolume }).catch(() => {});
  }
  const audioKeys = ['captureMic', 'captureSystemAudio', 'micDeviceId', 'noiseSuppression'];
  if (audioKeys.some((k) => k in patch) && overlayVisible()) setMetering(true);
  if ('indicatorCorner' in patch || 'displayId' in patch) positionIndicator();
  if (settings.showIndicator === false) setIndicator(null);
  return { settings, failedHotkeys };
});

handle('hotkeys:suspend', (suspend) => {
  hotkeysSuspended = !!suspend;
  return registerHotkeys();
});

handle('startup:warnings', () => {
  const w = startupWarnings;
  startupWarnings = [];
  return w;
});

handle('toasts:pending', () => {
  const t = pendingToasts;
  pendingToasts = [];
  return t;
});

handle('displays:list', async () => {
  displaysCache = await call('listDisplays');
  return displaysCache.map(({ displayId, name, primary }) => ({ displayId, name, primary }));
});

handle('encoders:list', () => call('encoders'));

handle('mics:list', async () => (await call('listMics')).map((name) => ({ id: name, name })));

handle('rec:state', () => recState);
handle('rec:start', startRecording);
handle('rec:stop', stopRecording);
handle('rec:pause', togglePause);
handle('rec:marker', addMarker);

handle('recovery:run', async () => {
  if (recoveryDone) return [];
  recoveryDone = true;
  return call('recover', { outDir: settings.outputDir });
});

handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(overlay, {
    title: 'Velg hvor opptak skal lagres',
    defaultPath: settings.outputDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('autostart:get', () => getAutostart());
handle('autostart:set', (on) => setAutostart(!!on));

handle('shell:openFolder', () => openOutputDir());
handle('shell:showFile', (file) => shell.showItemInFolder(file));
handle('shell:openFile', (file) => shell.openPath(file));

handle('recent:list', () => {
  const dir = settings.outputDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(mp4|mp3|m4a|wav)$/i.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, path: path.join(dir, f), size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 6);
});

ipcMain.on('overlay:hide', () => hideOverlay());
ipcMain.on('app:quit', () => requestQuit());

ipcMain.on('overlay:resize', (_e, height) => {
  if (!alive(overlay)) return;
  const area = screen.getDisplayMatching(overlay.getBounds()).workArea;
  overlay.setContentSize(OVERLAY_WIDTH, Math.max(120, Math.min(Math.ceil(height), area.height - 60)));
});

// ---------------------------------------------------------------- lifecycle

function requestQuit() {
  quitting = true;
  if (isRecording()) {
    stopRecording(); // quits once the file is saved
    setTimeout(() => app.exit(0), 10 * 60 * 1000);
  } else {
    app.quit();
  }
}

app.on('second-instance', () => showOverlay());
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* tray app: stay alive */ });
app.on('will-quit', () => {
  clearTimeout(indicatorTimer);
  globalShortcut.unregisterAll();
  engine?.stdin.end(); // the engine saves any running recording before exiting
});

app.whenReady().then(() => {
  app.setAppUserModelId('no.intervjueren.app');
  createTray();
  startupWarnings = registerHotkeys();
  startEngine();
  call('info').catch(() => {}); // probe the GPU encoder now so the first recording starts fast
  call('listDisplays').then((d) => { displaysCache = d; }).catch(() => {});
  if (!process.argv.includes('--hidden')) showOverlay();
});
