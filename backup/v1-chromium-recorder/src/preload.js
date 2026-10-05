'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const EVENTS = ['hotkey', 'overlay:visibility', 'convert:progress', 'hotkeys:failed', 'indicator:update'];

contextBridge.exposeInMainWorld('api', {
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  suspendHotkeys: invoke('hotkeys:suspend'),
  listSources: invoke('sources:list'),
  prepareCapture: invoke('capture:prepare'),
  startRec: invoke('rec:start'),
  writeChunk: invoke('rec:chunk'),
  marker: invoke('rec:marker'),
  stopRec: invoke('rec:stop'),
  reportState: (s) => ipcRenderer.send('rec:state', s),
  runRecovery: invoke('recovery:run'),
  pickFolder: invoke('dialog:pickFolder'),
  openFolder: invoke('shell:openFolder'),
  showFile: invoke('shell:showFile'),
  openFile: invoke('shell:openFile'),
  listRecent: invoke('recent:list'),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  resize: (h) => ipcRenderer.send('overlay:resize', h),
  on: (channel, fn) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
