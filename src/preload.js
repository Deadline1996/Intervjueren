'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Main answers { ok, data } / { ok: false, error }; turn that back into resolve / reject.
const invoke = (channel) => async (...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

const EVENTS = [
  'rec:state', 'toast', 'recent:changed', 'convert:progress', 'meters', 'overlay:visibility', 'indicator:update',
];

contextBridge.exposeInMainWorld('api', {
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  suspendHotkeys: invoke('hotkeys:suspend'),
  takeStartupWarnings: invoke('startup:warnings'),
  takePendingToasts: invoke('toasts:pending'),
  listDisplays: invoke('displays:list'),
  listMics: invoke('mics:list'),
  listEncoders: invoke('encoders:list'),
  getAutostart: invoke('autostart:get'),
  setAutostart: invoke('autostart:set'),
  getState: invoke('rec:state'),
  startRecording: invoke('rec:start'),
  stopRecording: invoke('rec:stop'),
  togglePause: invoke('rec:pause'),
  addMarker: invoke('rec:marker'),
  runRecovery: invoke('recovery:run'),
  pickFolder: invoke('dialog:pickFolder'),
  openFolder: invoke('shell:openFolder'),
  showFile: invoke('shell:showFile'),
  openFile: invoke('shell:openFile'),
  listRecent: invoke('recent:list'),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  quitApp: () => ipcRenderer.send('app:quit'),
  resize: (h) => ipcRenderer.send('overlay:resize', h),
  on: (channel, fn) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
