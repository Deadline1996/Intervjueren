'use strict';
const pill = document.getElementById('pill');
const text = document.getElementById('text');
let holdUntil = 0;
window.api.on('indicator:update', ({ state, text: t, flash }) => {
  const now = Date.now();
  if (!flash && now < holdUntil && (state === 'recording' || state === 'paused')) return;
  if (flash) holdUntil = now + 1800;
  pill.className = `pill ${state}${flash ? ' flash' : ''}`;
  text.textContent = t;
});
