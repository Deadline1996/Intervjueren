'use strict';
// Builds the Rust recording engine and copies it into bin/ next to ffmpeg.exe.
// Run with: npm run engine   (needs the Rust toolchain; only required after changing engine/)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
execSync('cargo build --release --manifest-path engine/Cargo.toml', { cwd: root, stdio: 'inherit' });
fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
fs.copyFileSync(
  path.join(root, 'engine', 'target', 'release', 'intervjueren-engine.exe'),
  path.join(root, 'bin', 'intervjueren-engine.exe'),
);
console.log('engine copied to bin/');
