'use strict';
// Downloads the ffmpeg build Intervjueren is tested with into bin/ffmpeg.exe.
// Run with: npm run ffmpeg   (runs automatically before `npm run pack` / `npm run dist`)
//
// Pinned to gyan.dev's ffmpeg 8.0.1 "essentials": it has ddagrab, scale_d3d11, NVENC/AMF/QSV and
// x264 with no DLL dependencies. Don't bump to 9.0: scale_d3d11 fails there, which breaks NVENC.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '8.0.1';
const URL = `https://github.com/GyanD/codexffmpeg/releases/download/${VERSION}/ffmpeg-${VERSION}-essentials_build.zip`;
const BIN = path.join(__dirname, '..', 'bin');
const TARGET = path.join(BIN, 'ffmpeg.exe');

function installedVersion() {
  try {
    return execFileSync(TARGET, ['-hide_banner', '-version'], { encoding: 'utf8' }).split(' ')[2] || '';
  } catch {
    return '';
  }
}

(async () => {
  if (installedVersion().startsWith(VERSION) && !process.argv.includes('--force')) {
    console.log(`bin/ffmpeg.exe is already ${VERSION}`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intervjueren-ffmpeg-'));
  try {
    console.log(`Downloading ffmpeg ${VERSION} essentials…`);
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const zip = path.join(tmp, 'ffmpeg.zip');
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

    // Windows 10+ ships bsdtar, which extracts zip files. Call it by full path: a GNU tar from
    // Git Bash earlier in PATH can't read zips and treats "C:" as a remote host.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', zip, '-C', tmp]);
    const dir = fs.readdirSync(tmp).find((d) => d.startsWith('ffmpeg-'));
    fs.mkdirSync(BIN, { recursive: true });
    fs.copyFileSync(path.join(tmp, dir, 'bin', 'ffmpeg.exe'), TARGET);
    fs.copyFileSync(path.join(tmp, dir, 'LICENSE'), path.join(BIN, 'ffmpeg-LICENSE.txt'));
    console.log(`bin/ffmpeg.exe → ${installedVersion()}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
