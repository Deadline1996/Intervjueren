'use strict';
// Thin bridge from the UI to the Rust backend (window.__TAURI__ comes from withGlobalTauri).
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.api = {
    getSettings: () => invoke('get_settings'),
    setSettings: (patch) => invoke('set_settings', { patch }),
    suspendHotkeys: (suspend) => invoke('suspend_hotkeys', { suspend }),
    takeStartupWarnings: () => invoke('take_startup_warnings'),
    listDisplays: () => invoke('list_displays'),
    listMics: () => invoke('list_mics'),
    getState: () => invoke('get_state'),
    startRecording: () => invoke('start_recording'),
    stopRecording: () => invoke('stop_recording'),
    togglePause: () => invoke('toggle_pause'),
    addMarker: () => invoke('add_marker'),
    runRecovery: () => invoke('run_recovery'),
    pickFolder: () => invoke('pick_folder'),
    openFolder: () => invoke('open_folder'),
    showFile: (path) => invoke('show_file', { path }),
    openFile: (path) => invoke('open_file', { path }),
    listRecent: () => invoke('list_recent'),
    hideOverlay: () => invoke('hide_overlay_cmd'),
    resize: (height) => invoke('resize_overlay', { height }),
    on: (event, fn) => listen(event, (e) => fn(e.payload)),
  };
})();
