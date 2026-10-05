'use strict';
const {
  app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, session,
  Tray, Menu, nativeImage, dialog, shell, screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

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
  displayId: null,               // which monitor to capture (null = primary)
  resolution: '1080',            // 'native' | '1440' | '1080' | '720'
  fps: 30,
  quality: 'medium',             // 'low' | 'medium' | 'high'
  captureSystemAudio: true,      // game + voice chat (Windows loopback)
  captureMic: true,
  micDeviceId: 'default',
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

let overlay = null;
let indicator = null;
let tray = null;
let quitting = false;
let rec = null;               // active recording session (see rec:start)
let recState = 'idle';        // mirrored from the renderer for tray/indicator
let pendingCapture = { displayId: null, loopback: false };
let recoveryDone = false;
let hotkeysSuspended = false;
let indicatorTimer = null;

const alive = (win) => win && !win.isDestroyed();

const send = (win, channel, data) => {
  if (alive(win)) win.webContents.send(channel, data);
};

// ---------------------------------------------------------------- helpers

function pad(n) { return String(n).padStart(2, '0'); }

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

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

// ---------------------------------------------------------------- windows

const PRELOAD = path.join(__dirname, 'preload.js');
const OVERLAY_WIDTH = 440;

function createOverlay() {
  overlay = new BrowserWindow({
    width: OVERLAY_WIDTH, height: 640,
    show: false, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
    maximizable: false, minimizable: false, hasShadow: false,
    title: 'Intervjueren',
    icon: path.join(ASSETS, 'app.png'),
    webPreferences: { preload: PRELOAD, backgroundThrottling: false, contextIsolation: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setContentProtection(true); // keep the overlay itself out of recordings
  overlay.loadFile(path.join(__dirname, 'overlay', 'index.html'));
  overlay.on('close', (e) => {
    if (!quitting) { e.preventDefault(); hideOverlay(); }
  });
}

function createIndicator() {
  indicator = new BrowserWindow({
    width: 190, height: 44,
    show: false, frame: false, transparent: true, resizable: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false, contextIsolation: true },
  });
  indicator.setAlwaysOnTop(true, 'screen-saver');
  indicator.setIgnoreMouseEvents(true);
  indicator.setContentProtection(true);
  indicator.loadFile(path.join(__dirname, 'indicator', 'index.html'));
}

function targetDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(settings.displayId)) || screen.getPrimaryDisplay();
}

function showOverlay() {
  if (!alive(overlay)) return;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [w] = overlay.getSize();
  overlay.setPosition(Math.round(area.x + (area.width - w) / 2), area.y + 40);
  overlay.show();
  overlay.focus();
  send(overlay, 'overlay:visibility', true);
}

function hideOverlay() {
  if (!alive(overlay)) return;
  overlay.hide();
  send(overlay, 'overlay:visibility', false);
}

function toggleOverlay() {
  if (!alive(overlay)) return;
  if (overlay.isVisible()) hideOverlay(); else showOverlay();
}

function positionIndicator() {
  if (!alive(indicator)) return;
  const area = targetDisplay().workArea;
  const [w, h] = indicator.getSize();
  const m = 14;
  const corner = settings.indicatorCorner || 'top-right';
  const x = corner.endsWith('left') ? area.x + m : area.x + area.width - w - m;
  const y = corner.startsWith('top') ? area.y + m : area.y + area.height - h - m;
  indicator.setPosition(Math.round(x), Math.round(y));
}

function setIndicator(data, autoHideMs = 0) {
  clearTimeout(indicatorTimer);
  if (!alive(indicator)) return;
  if (!data || !settings.showIndicator) {
    if (indicator.isVisible()) indicator.hide();
    return;
  }
  send(indicator, 'indicator:update', data);
  if (!indicator.isVisible()) {
    positionIndicator();
    indicator.showInactive();
    indicator.setAlwaysOnTop(true, 'screen-saver');
  }
  if (autoHideMs) indicatorTimer = setTimeout(() => alive(indicator) && indicator.hide(), autoHideMs);
}

// ---------------------------------------------------------------- tray

function updateTray(elapsedMs) {
  if (!tray) return;
  tray.setImage(icon(recState));
  const label = recState === 'idle' ? 'Inaktiv'
    : `${recState === 'paused' ? 'Pauset' : 'Tar opp'} ${elapsedMs != null ? fmtTime(elapsedMs) : ''}`;
  tray.setToolTip(`Intervjueren — ${label}`);
}

function buildTrayMenu() {
  const hk = settings.hotkeys;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Vis / skjul overlegg', accelerator: hk.toggleOverlay, click: toggleOverlay },
    { label: 'Start / stopp opptak', accelerator: hk.toggleRecord, click: () => send(overlay, 'hotkey', 'toggleRecord') },
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
    toggleOverlay: () => toggleOverlay(),
    toggleRecord: () => send(overlay, 'hotkey', 'toggleRecord'),
    pause: () => send(overlay, 'hotkey', 'pause'),
    marker: () => send(overlay, 'hotkey', 'marker'),
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

// ---------------------------------------------------------------- capture

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const wanted = String(pendingCapture.displayId ?? screen.getPrimaryDisplay().id);
      const src = sources.find((s) => s.display_id === wanted) || sources[0];
      if (!src) return callback({});
      const resp = { video: src };
      if (pendingCapture.loopback) resp.audio = 'loopback';
      callback(resp);
    } catch (err) {
      console.error('display media handler failed', err);
      callback({});
    }
  }, { useSystemPicker: false });
}

async function listSources() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const displays = screen.getAllDisplays();
  const primaryId = String(screen.getPrimaryDisplay().id);
  return sources.map((s, i) => {
    const d = displays.find((x) => String(x.id) === s.display_id);
    const res = d ? ` — ${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}` : '';
    return {
      displayId: s.display_id,
      name: `Skjerm ${i + 1}${res}${s.display_id === primaryId ? ' (hovedskjerm)' : ''}`,
      primary: s.display_id === primaryId,
    };
  });
}

// ---------------------------------------------------------------- recording files

function rawDir(outDir) { return path.join(outDir, '.raw'); }

function uniqueBase(outDir, base, ext) {
  let name = base;
  for (let i = 2; fs.existsSync(path.join(outDir, `${name}.${ext}`)); i++) name = `${base}_${i}`;
  return name;
}

function ffmpegArgs(meta, finalPath) {
  const args = ['-y', '-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
    '-fflags', '+genpts', '-i', meta.rawPath];
  if (meta.kind === 'video') {
    if (meta.codec === 'h264') args.push('-c:v', 'copy');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  } else {
    args.push('-vn');
    if (meta.finalExt === 'wav') args.push('-c:a', 'pcm_s16le');
    else if (meta.finalExt === 'm4a') args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
    else args.push('-c:a', 'libmp3lame', '-b:a', '192k');
  }
  args.push(finalPath);
  return args;
}

function runFfmpeg(args, durationMs, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let errTail = '';
    p.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m && durationMs > 0) onProgress(Math.min(99, Math.round((Number(m[1]) / 1000 / durationMs) * 100)));
    });
    p.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errTail.trim().split(/\r?\n/).slice(-2).join(' ') || `ffmpeg avsluttet med kode ${code}`));
    });
  });
}

async function finalize(meta, durationMs) {
  const metaPath = meta.rawPath.replace(/\.[^.]+$/, '.json');
  const size = fs.existsSync(meta.rawPath) ? fs.statSync(meta.rawPath).size : 0;
  if (size === 0) {
    fs.rmSync(meta.rawPath, { force: true });
    fs.rmSync(metaPath, { force: true });
    return { ok: false, error: 'Ingenting ble tatt opp.' };
  }
  const finalPath = path.join(meta.outDir, `${meta.base}.${meta.finalExt}`);
  try {
    await runFfmpeg(ffmpegArgs(meta, finalPath), durationMs, (pct) => {
      send(overlay, 'convert:progress', { base: meta.base, pct });
    });
  } catch (err) {
    fs.rmSync(finalPath, { force: true });
    return { ok: false, error: err.message, raw: meta.rawPath };
  }
  if (!settings.keepRaw) fs.rmSync(meta.rawPath, { force: true });
  fs.rmSync(metaPath, { force: true });
  return { ok: true, file: finalPath };
}

function openOutputDir() {
  fs.mkdirSync(settings.outputDir, { recursive: true });
  shell.openPath(settings.outputDir);
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('settings:get', () => settings);

ipcMain.handle('settings:set', (_e, patch) => {
  const hotkeysChanged = patch.hotkeys && JSON.stringify(patch.hotkeys) !== JSON.stringify(settings.hotkeys);
  settings = { ...settings, ...patch, hotkeys: { ...settings.hotkeys, ...(patch.hotkeys || {}) } };
  saveSettings();
  let failedHotkeys = [];
  if (hotkeysChanged) {
    failedHotkeys = registerHotkeys();
    buildTrayMenu();
  }
  if ('indicatorCorner' in patch || 'displayId' in patch) positionIndicator();
  if (settings.showIndicator === false) setIndicator(null);
  return { settings, failedHotkeys };
});

ipcMain.handle('hotkeys:suspend', (_e, suspend) => {
  hotkeysSuspended = !!suspend;
  return registerHotkeys();
});

ipcMain.handle('sources:list', listSources);

ipcMain.handle('capture:prepare', (_e, opts) => { pendingCapture = opts; });

ipcMain.handle('rec:start', (_e, { kind, ext, codec, audioFormat }) => {
  if (rec) throw new Error('Tar allerede opp');
  const outDir = settings.outputDir;
  fs.mkdirSync(rawDir(outDir), { recursive: true });
  const finalExt = kind === 'video' ? 'mp4' : audioFormat;
  const base = uniqueBase(outDir, `${kind === 'video' ? 'Intervju' : 'Intervju-lyd'}_${stamp()}`, finalExt);
  const rawPath = path.join(rawDir(outDir), `${base}.${ext}`);
  const meta = { base, kind, codec, rawPath, outDir, finalExt, startedAt: Date.now() };
  // The .json sidecar lets us recover the recording if the app or PC dies mid-interview.
  fs.writeFileSync(rawPath.replace(/\.[^.]+$/, '.json'), JSON.stringify(meta));
  rec = { ...meta, fd: fs.openSync(rawPath, 'w'), markerCount: 0 };
  return { base, outDir };
});

ipcMain.handle('rec:chunk', (_e, data) => {
  if (!rec) return false;
  fs.writeSync(rec.fd, Buffer.from(data));
  return true;
});

ipcMain.handle('rec:marker', (_e, { elapsedMs, note }) => {
  if (!rec) return null;
  rec.markerCount++;
  const file = path.join(rec.outDir, `${rec.base}.markører.txt`);
  fs.appendFileSync(file, `${fmtTime(elapsedMs)}  ${note || `Markør ${rec.markerCount}`}\r\n`);
  setIndicator({ state: recState, text: `Markør ${rec.markerCount} ved ${fmtTime(elapsedMs)}`, flash: true });
  return { count: rec.markerCount };
});

ipcMain.handle('rec:stop', async (_e, { durationMs }) => {
  if (!rec) return { ok: false, error: 'Tar ikke opp.' };
  const r = rec;
  rec = null;
  fs.closeSync(r.fd);
  recState = 'idle';
  updateTray();
  setIndicator({ state: 'saving', text: 'Lagrer…' });
  const result = await finalize(r, durationMs);
  setIndicator(
    result.ok ? { state: 'saved', text: 'Lagret ✓' } : { state: 'error', text: 'Lagring feilet' },
    result.ok ? 2500 : 6000,
  );
  if (quitting) setImmediate(() => app.quit());
  return result;
});

ipcMain.on('rec:state', (_e, { state, elapsedMs }) => {
  recState = state;
  updateTray(elapsedMs);
  if (state === 'recording' || state === 'paused') {
    setIndicator({ state, text: `${state === 'paused' ? 'PAUSE' : 'REC'} ${fmtTime(elapsedMs)}` });
  }
});

ipcMain.handle('recovery:run', async () => {
  if (recoveryDone) return [];
  recoveryDone = true;
  const dir = rawDir(settings.outputDir);
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (rec && rec.base === meta.base) continue;
      meta.outDir = settings.outputDir;
      meta.rawPath = path.join(dir, path.basename(meta.rawPath));
      meta.base = uniqueBase(meta.outDir, `${meta.base}_gjenopprettet`, meta.finalExt);
      results.push({ name: f, ...(await finalize(meta, 0)) });
    } catch (err) {
      results.push({ name: f, ok: false, error: err.message });
    }
  }
  return results;
});

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(overlay, {
    title: 'Velg hvor opptak skal lagres',
    defaultPath: settings.outputDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:openFolder', () => openOutputDir());
ipcMain.handle('shell:showFile', (_e, file) => shell.showItemInFolder(file));
ipcMain.handle('shell:openFile', (_e, file) => shell.openPath(file));

ipcMain.handle('recent:list', () => {
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

ipcMain.on('overlay:resize', (_e, height) => {
  if (!alive(overlay)) return;
  const area = screen.getDisplayMatching(overlay.getBounds()).workArea;
  overlay.setContentSize(OVERLAY_WIDTH, Math.max(120, Math.min(Math.ceil(height), area.height - 60)));
});

// ---------------------------------------------------------------- lifecycle

function requestQuit() {
  quitting = true;
  if (rec) {
    // Let the renderer flush and convert the recording first; rec:stop quits afterwards.
    send(overlay, 'hotkey', 'stopForQuit');
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
});

app.whenReady().then(() => {
  app.setAppUserModelId('no.intervjueren.app');
  installDisplayMediaHandler();
  createOverlay();
  createIndicator();
  createTray();
  const failed = registerHotkeys();
  overlay.webContents.once('did-finish-load', () => {
    if (failed.length) send(overlay, 'hotkeys:failed', failed);
    showOverlay();
  });
});
