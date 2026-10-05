'use strict';
/* global api */

const $ = (id) => document.getElementById(id);

const VIDEO_FORMATS = [
  { mime: 'video/x-matroska;codecs=avc1,opus', ext: 'mkv', codec: 'h264' },
  { mime: 'video/webm;codecs=h264,opus', ext: 'webm', codec: 'h264' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm', codec: 'vp9' },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm', codec: 'vp8' },
];
const AUDIO_FORMAT = { mime: 'audio/webm;codecs=opus', ext: 'webm', codec: 'opus' };
const BITS_PER_PIXEL = { low: 0.05, medium: 0.08, high: 0.13 };
const HOTKEY_LABELS = { toggleOverlay: 'overlegg', toggleRecord: 'opptak', pause: 'pause', marker: 'markør' };

let settings = null;
let state = 'idle';            // idle | starting | recording | paused | stopping
let overlayVisible = true;

// active recording
let recorder = null;
let ownedStreams = [];
let graph = {};                // { mic: {gain, analyser, src}, sys: {...} }
let writeChain = Promise.resolve();
let writeError = null;
let bytesWritten = 0;
let elapsedBase = 0;
let segmentStart = 0;
let currentFile = null;
let markerCount = 0;
let ticker = null;
let stopAndQuit = false;

// idle mic preview (so you can check levels before the interview)
let preview = null;

let audioCtx = null;
const ctx = () => (audioCtx ||= new AudioContext({ sampleRate: 48000 }));

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
function elapsed() {
  return elapsedBase + (state === 'recording' ? performance.now() - segmentStart : 0);
}
function prettyAccel(a) {
  return (a || '—').replace('Control', 'Ctrl').replace('CommandOrControl', 'Ctrl').replace('Super', 'Win');
}

function toast(msg, kind = 'info', ms = 7000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').append(el);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

function friendlyError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError') return 'Windows blokkerte skjermopptaket. Prøv igjen, eller velg en annen skjerm i Innstillinger.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Fant ikke valgt mikrofon — velg en annen i Innstillinger.';
  if (name === 'NotReadableError') return 'Enheten er opptatt eller utilgjengelig (et annet program bruker den kanskje eksklusivt).';
  return err?.message || String(err);
}

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
    el.addEventListener('input', () => {
      $(`${id}Out`).textContent = `${Math.round(el.value * 100)}%`;
      live?.(Number(el.value));
    });
    $(`${id}Out`).textContent = `${Math.round(el.value * 100)}%`;
  }
}

async function loadSources() {
  const sel = $('displayId');
  const sources = await api.listSources();
  sel.innerHTML = '';
  for (const s of sources) sel.append(new Option(s.name, s.displayId));
  const wanted = settings.displayId && sources.find((s) => s.displayId === String(settings.displayId));
  sel.value = wanted ? wanted.displayId : (sources.find((s) => s.primary) || sources[0])?.displayId ?? '';
}

async function loadMics() {
  const sel = $('micDeviceId');
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  sel.innerHTML = '';
  sel.append(new Option('Systemets standardmikrofon', 'default'));
  devices
    .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    .forEach((d, i) => sel.append(new Option(d.label || `Mikrofon ${i + 1}`, d.deviceId)));
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

function renderHints() {
  const hk = settings.hotkeys;
  $('hints').innerHTML = '';
  const add = (label, acc) => {
    const span = document.createElement('span');
    const kbd = document.createElement('kbd');
    kbd.textContent = prettyAccel(acc);
    span.append(kbd, ` ${label}`);
    $('hints').append(span);
  };
  add('overlegg', hk.toggleOverlay);
  add('opptak', hk.toggleRecord);
  add('pause', hk.pause);
  add('markør', hk.marker);
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
      const isFKey = /^F\d{1,2}$/.test(key);
      if (!mods.length && !isFKey) {
        input.classList.add('bad');
        input.value = 'Legg til Ctrl / Alt / Shift';
        setTimeout(() => input.classList.remove('bad'), 1200);
        return;
      }
      const accel = [...mods, key].join('+');
      input.classList.remove('capturing');
      input.value = prettyAccel(accel);
      await saveSetting({ hotkeys: { [input.dataset.key]: accel } });
      input.blur();
    });
  }
}

function renderOutputDir() {
  const dir = settings.outputDir;
  const parts = dir.split(/[\\/]/).filter(Boolean);
  const short = dir.length > 48 && parts.length > 3 ? [parts[0], '…', ...parts.slice(-2)].join('\\') : dir;
  $('outputDir').textContent = short;
  $('outputDir').title = `${dir}\nKlikk for å åpne mappen`;
}

async function setupSettings() {
  settings = await api.getSettings();
  renderOutputDir();

  await loadSources();
  $('displayId').addEventListener('change', () => saveSetting({ displayId: $('displayId').value }));

  bindSetting('resolution');
  bindSetting('fps', { parse: Number });
  bindSetting('quality');
  bindSetting('captureSystemAudio', { type: 'checked', live: renderMode });
  bindSetting('systemVolume', { parse: Number, live: (v) => graph.sys && (graph.sys.gain.gain.value = v) });
  bindSetting('captureMic', { type: 'checked', live: () => { renderMode(); restartPreview(); } });
  bindSetting('micVolume', { parse: Number, live: (v) => graph.mic && (graph.mic.gain.gain.value = v) });
  bindSetting('noiseSuppression', { type: 'checked', live: restartPreview });
  bindSetting('audioFormat', { live: renderMode });
  bindSetting('showIndicator', { type: 'checked' });
  bindSetting('indicatorCorner');
  bindSetting('keepRaw', { type: 'checked' });

  await loadMics();
  $('micDeviceId').addEventListener('change', async () => {
    await saveSetting({ micDeviceId: $('micDeviceId').value });
    restartPreview();
  });
  navigator.mediaDevices.addEventListener('devicechange', loadMics);

  $('browseBtn').addEventListener('click', async () => {
    const dir = await api.pickFolder();
    if (dir) {
      await saveSetting({ outputDir: dir });
      renderOutputDir();
      refreshRecent();
      toast(state === 'idle' ? `Nye opptak lagres i ${dir}` : `Pågående opptak lagres fortsatt i den gamle mappen; nye opptak havner i ${dir}`, 'ok', 5000);
    }
  });
  $('outputDir').addEventListener('click', () => api.openFolder());

  for (const b of $('modeSeg').querySelectorAll('button')) {
    b.addEventListener('click', async () => {
      if (state !== 'idle') return;
      await saveSetting({ mode: b.dataset.mode });
      renderMode();
    });
  }

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
    const icon = document.createElement('span');
    icon.className = 'tag';
    icon.textContent = it.name.split('.').pop().toUpperCase();
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = fmtSize(it.size);
    li.append(icon, name, size);
    li.addEventListener('click', () => api.showFile(it.path));
    li.addEventListener('dblclick', () => api.openFile(it.path));
    ul.append(li);
  }
}

// ---------------------------------------------------------------- meters

function makeAnalyser(source) {
  const an = ctx().createAnalyser();
  an.fftSize = 1024;
  source.connect(an);
  return an;
}

function level(an) {
  if (!an) return 0;
  const buf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(buf);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const db = 20 * Math.log10(peak || 1e-6);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

function meterLoop() {
  const micAn = graph.mic?.analyser || preview?.analyser;
  $('micMeter').style.width = `${level(micAn) * 100}%`;
  $('sysMeter').style.width = `${level(graph.sys?.analyser) * 100}%`;
  requestAnimationFrame(meterLoop);
}

async function getMic() {
  const id = settings.micDeviceId;
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: id && id !== 'default' ? { exact: id } : undefined,
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: settings.noiseSuppression,
      channelCount: 1,
    },
  });
}

async function startPreview() {
  if (preview || state !== 'idle' || !overlayVisible || !settings.captureMic) return;
  try {
    const stream = await getMic();
    if (state !== 'idle' || !overlayVisible) { stream.getTracks().forEach((t) => t.stop()); return; }
    await ctx().resume();
    const src = ctx().createMediaStreamSource(stream);
    preview = { stream, src, analyser: makeAnalyser(src) };
    loadMics(); // labels become available once mic permission is in use
  } catch (err) {
    toast(`Mikrofon: ${friendlyError(err)}`, 'warn');
  }
}

function stopPreview() {
  if (!preview) return;
  preview.src.disconnect();
  preview.stream.getTracks().forEach((t) => t.stop());
  preview = null;
}

function restartPreview() {
  stopPreview();
  startPreview();
}

// ---------------------------------------------------------------- recording

function setState(s) {
  state = s;
  const recBtn = $('recBtn');
  const active = s === 'recording' || s === 'paused';
  recBtn.classList.toggle('stop', active || s === 'stopping');
  recBtn.disabled = s === 'starting' || s === 'stopping';
  $('recBtnText').textContent = {
    idle: 'Start opptak', starting: 'Starter…', recording: 'Stopp og lagre', paused: 'Stopp og lagre', stopping: 'Lagrer…',
  }[s];
  $('pauseBtn').disabled = !active;
  $('pauseBtn').classList.toggle('active', s === 'paused');
  $('markerBtn').disabled = !active;
  $('stateLabel').className = `state ${s === 'stopping' ? 'saving' : s}`;
  $('stateLabel').textContent = {
    idle: 'Klar', starting: 'Starter', recording: '● Tar opp', paused: 'Pauset', stopping: 'Lagrer',
  }[s];
  $('lockable').disabled = s !== 'idle';
  $('modeSeg').classList.toggle('locked', s !== 'idle');
  if (s === 'idle') $('timer').textContent = '00:00:00';
}

function tick() {
  const ms = elapsed();
  $('timer').textContent = fmtTime(ms);
  $('metaLine').textContent = `${currentFile} · ${fmtSize(bytesWritten)}${markerCount ? ` · ${markerCount} markør${markerCount > 1 ? 'er' : ''}` : ''}`;
  api.reportState({ state, elapsedMs: ms });
}

function pickVideoFormat() {
  return VIDEO_FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mime));
}

async function scaleVideoTrack(track) {
  const { width, height } = track.getSettings();
  const target = Number(settings.resolution);
  let w = width;
  let h = height;
  if (target && height > target) {
    h = target;
    w = Math.round((width * target) / height / 2) * 2;
  }
  try {
    await track.applyConstraints({ width: w, height: h, frameRate: settings.fps });
  } catch (err) {
    console.warn('applyConstraints failed', err);
  }
  const s = track.getSettings();
  return { width: s.width || w, height: s.height || h };
}

function connectAudio(stream, volume, dest) {
  const src = ctx().createMediaStreamSource(stream);
  const gain = ctx().createGain();
  gain.gain.value = volume;
  src.connect(gain);
  gain.connect(dest);
  return { src, gain, analyser: makeAnalyser(gain) };
}

function releaseCapture() {
  for (const g of Object.values(graph)) {
    g.src.disconnect();
    g.gain.disconnect();
  }
  graph = {};
  ownedStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  ownedStreams = [];
  recorder = null;
}

async function startRecording() {
  if (state !== 'idle') return;
  setState('starting');
  stopPreview();
  const isVideo = settings.mode === 'video';
  try {
    let display = null;
    if (isVideo || settings.captureSystemAudio) {
      await api.prepareCapture({ displayId: $('displayId').value || null, loopback: settings.captureSystemAudio });
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: settings.fps },
        audio: settings.captureSystemAudio,
      });
      ownedStreams.push(display);
    }

    let mic = null;
    if (settings.captureMic) {
      try {
        mic = await getMic();
        ownedStreams.push(mic);
      } catch (err) {
        if (!display?.getAudioTracks().length) throw err;
        toast(`Mikrofonen feilet (${friendlyError(err)}) — tar opp uten den!`, 'error', 15000);
      }
    }

    await ctx().resume();
    const dest = ctx().createMediaStreamDestination();
    const sysTrack = display?.getAudioTracks()[0];
    if (sysTrack) graph.sys = connectAudio(new MediaStream([sysTrack]), settings.systemVolume, dest);
    if (mic) graph.mic = connectAudio(mic, settings.micVolume, dest);
    const hasAudio = !!(sysTrack || mic);
    if (settings.captureSystemAudio && !sysTrack) toast('Systemlyd er ikke tilgjengelig — bare mikrofonen tas opp.', 'warn');
    if (!hasAudio && !isVideo) throw new Error('Kun lyd krever at mikrofon og/eller systemlyd er slått på (Innstillinger → Lyd).');
    if (!hasAudio) toast('Tar opp video UTEN lyd — begge lydkildene er slått av.', 'warn', 12000);

    const out = new MediaStream();
    let fmt;
    let videoBitsPerSecond;
    if (isVideo) {
      fmt = pickVideoFormat();
      if (!fmt) throw new Error('Fant ingen støttet videokoder.');
      const vt = display.getVideoTracks()[0];
      const { width, height } = await scaleVideoTrack(vt);
      videoBitsPerSecond = Math.round(Math.min(40e6, Math.max(1.5e6, width * height * settings.fps * BITS_PER_PIXEL[settings.quality])));
      vt.addEventListener('ended', () => {
        if (state === 'recording' || state === 'paused') {
          toast('Skjermopptaket stoppet uventet — det som ble tatt opp er lagret.', 'error', 15000);
          stopRecording();
        }
      });
      out.addTrack(vt);
    } else {
      fmt = AUDIO_FORMAT;
      // System audio comes bundled with a screen video track; idle it as cheaply as possible.
      for (const vt of display?.getVideoTracks() || []) {
        vt.applyConstraints({ width: 320, height: 180, frameRate: 1 }).catch(() => {});
        vt.enabled = false;
      }
    }
    if (hasAudio) out.addTrack(dest.stream.getAudioTracks()[0]);

    recorder = new MediaRecorder(out, { mimeType: fmt.mime, videoBitsPerSecond, audioBitsPerSecond: 192000 });
    const { base } = await api.startRec({
      kind: isVideo ? 'video' : 'audio', ext: fmt.ext, codec: fmt.codec, audioFormat: settings.audioFormat,
    });
    currentFile = `${base}.${isVideo ? 'mp4' : settings.audioFormat}`;
    bytesWritten = 0;
    markerCount = 0;
    writeError = null;
    writeChain = Promise.resolve();

    recorder.addEventListener('dataavailable', (e) => {
      if (!e.data.size) return;
      const blob = e.data;
      writeChain = writeChain
        .then(async () => {
          await api.writeChunk(new Uint8Array(await blob.arrayBuffer()));
          bytesWritten += blob.size;
        })
        .catch((err) => {
          if (!writeError) {
            writeError = err;
            toast(`Skriving til disk feilet: ${err.message}`, 'error', 0);
            stopRecording();
          }
        });
    });
    recorder.addEventListener('error', (e) => {
      toast(`Opptaksfeil: ${e.error?.message || 'ukjent'} — lagrer det som ble tatt opp.`, 'error', 15000);
      stopRecording();
    });

    recorder.start(1000); // flush to disk every second so a crash loses at most ~1s
    elapsedBase = 0;
    segmentStart = performance.now();
    setState('recording');
    tick();
    ticker = setInterval(tick, 500);
    if (isVideo) toast(`Tar opp ${fmt.codec.toUpperCase()} · ${(videoBitsPerSecond / 1e6).toFixed(1).replace('.', ',')} Mbps`, 'info', 4000);
  } catch (err) {
    console.error(err);
    releaseCapture();
    setState('idle');
    toast(friendlyError(err), 'error', 12000);
    startPreview();
  }
}

function togglePause() {
  if (state === 'recording') {
    recorder.pause();
    elapsedBase += performance.now() - segmentStart;
    setState('paused');
  } else if (state === 'paused') {
    recorder.resume();
    segmentStart = performance.now();
    setState('recording');
  } else return;
  tick();
}

async function dropMarker() {
  if (state !== 'recording' && state !== 'paused') return;
  const r = await api.marker({ elapsedMs: elapsed() });
  if (r) {
    markerCount = r.count;
    toast(`Markør ${r.count} ved ${fmtTime(elapsed())}`, 'info', 2500);
    tick();
  }
}

async function stopRecording() {
  if (state !== 'recording' && state !== 'paused') return;
  const durationMs = elapsed();
  clearInterval(ticker);
  setState('stopping');
  $('timer').textContent = fmtTime(durationMs);
  const rec = recorder;
  await new Promise((resolve) => {
    if (rec.state === 'inactive') return resolve();
    rec.addEventListener('stop', resolve, { once: true });
    try { rec.stop(); } catch { resolve(); }
  });
  await writeChain;
  releaseCapture();

  $('progress').classList.remove('hidden');
  $('progressBar').style.width = '0';
  const result = await api.stopRec({ durationMs });
  $('progress').classList.add('hidden');
  $('metaLine').textContent = '';
  setState('idle');

  if (result.ok) {
    const t = toast(`Lagret ${result.file.split(/[\\/]/).pop()} — klikk for å vise`, 'ok', 12000);
    t.style.cursor = 'pointer';
    t.addEventListener('click', () => api.showFile(result.file));
  } else {
    toast(`Lagring feilet: ${result.error}${result.raw ? `\nRått opptak beholdt i: ${result.raw}` : ''}`, 'error', 0);
  }
  refreshRecent();
  if (stopAndQuit) return;
  startPreview();
}

function toggleRecord() {
  if (state === 'idle') startRecording();
  else if (state === 'recording' || state === 'paused') stopRecording();
}

// ---------------------------------------------------------------- wiring

function setupEvents() {
  $('recBtn').addEventListener('click', toggleRecord);
  $('pauseBtn').addEventListener('click', togglePause);
  $('markerBtn').addEventListener('click', dropMarker);
  $('closeBtn').addEventListener('click', () => api.hideOverlay());
  $('openFolderBtn').addEventListener('click', () => api.openFolder());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.classList?.contains('hotkey')) api.hideOverlay();
  });

  api.on('hotkey', (action) => {
    if (action === 'toggleRecord') toggleRecord();
    else if (action === 'pause') togglePause();
    else if (action === 'marker') dropMarker();
    else if (action === 'stopForQuit') { stopAndQuit = true; stopRecording(); }
  });

  api.on('overlay:visibility', (visible) => {
    overlayVisible = visible;
    if (visible) {
      refreshRecent();
      loadSources();
      startPreview();
    } else {
      stopPreview();
    }
  });

  api.on('convert:progress', ({ pct }) => {
    $('progressBar').style.width = `${pct}%`;
    $('stateLabel').textContent = `Lagrer ${pct} %`;
  });

  api.on('hotkeys:failed', (failed) => {
    toast(`Kunne ikke registrere hurtigtast: ${failed.map((k) => HOTKEY_LABELS[k]).join(', ')} — endre den i Innstillinger.`, 'warn', 0);
  });

  new ResizeObserver(() => api.resize($('panel').getBoundingClientRect().height)).observe($('panel'));
}

async function recoverCrashed() {
  const results = await api.runRecovery();
  if (!results.length) return;
  for (const r of results) {
    if (r.ok) toast(`Gjenopprettet: ${r.file.split(/[\\/]/).pop()}`, 'ok', 0);
    else toast(`Kunne ikke gjenopprette ${r.name}: ${r.error}`, 'error', 0);
  }
  refreshRecent();
}

(async function init() {
  await setupSettings();
  setupEvents();
  setState('idle');
  refreshRecent();
  requestAnimationFrame(meterLoop);
  startPreview();
  recoverCrashed();
})();
