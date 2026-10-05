'use strict';
// Generates every icon/logo asset from assets/logo.svg:
//   assets/logo-wordmark.svg   mark + "INTERVJUEREN" (text outlined, no font needed)
//   build/icon.ico, icon.png   app / installer icon
//   src/assets/tray-*.png      tray icons per recording state (dot colour changes)
//   src/overlay/logo.svg       copy for the overlay header
// Run with: npm run icons
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');
const opentype = require('opentype.js');

const ROOT = path.join(__dirname, '..');
const p = (...x) => path.join(ROOT, ...x);
const FONT_DIR = p('node_modules', '@fontsource', 'barlow-condensed', 'files');
const loadFont = (f) => {
  const buf = fs.readFileSync(path.join(FONT_DIR, f));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};

const COLORS = { navy: '#0e121b', cyan: '#1fc6f2', text: '#f3f5f8', muted: '#8992a5', red: '#ff4646' };
const logoSvg = fs.readFileSync(p('assets', 'logo.svg'), 'utf8');

// opentype.js 2.0's toPathData() prints some whole-number coordinates as NaN, so serialise ourselves.
const n = (v) => +v.toFixed(2);
function pathData(path) {
  return path.commands.map((c) => {
    if (c.type === 'M' || c.type === 'L') return `${c.type}${n(c.x)} ${n(c.y)}`;
    if (c.type === 'Q') return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
    if (c.type === 'C') return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
    return 'Z';
  }).join('');
}

// Lay out text glyph by glyph so we can apply letter-spacing (in em) and kerning.
function textPath(font, text, x, y, size, spacingEm = 0) {
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(text);
  let cursor = x;
  const parts = [];
  glyphs.forEach((g, i) => {
    parts.push(pathData(g.getPath(cursor, y, size)));
    cursor += g.advanceWidth * scale + spacingEm * size;
    if (glyphs[i + 1]) cursor += font.getKerningValue(g, glyphs[i + 1]) * scale;
  });
  return { d: parts.join(''), width: cursor - x - spacingEm * size };
}

function buildWordmark({ title: titleColor, kicker: kickerColor }) {
  const heavy = loadFont('barlow-condensed-latin-800-italic.woff');
  const light = loadFont('barlow-condensed-latin-600-italic.woff');
  const markSize = 128;
  const left = markSize + 26;
  const kicker = textPath(light, 'FIVEM · INTERVJUOPPTAK', left + 2, 34, 15, 0.16);
  const title = textPath(heavy, 'INTERVJUEREN', left, 94, 70, -0.005);
  const width = Math.ceil(left + Math.max(title.width, kicker.width) + 30);
  const inner = logoSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${markSize}" width="${width}" height="${markSize}">
  <title>Intervjueren</title>
  <svg width="${markSize}" height="${markSize}" viewBox="0 0 256 256">${inner}</svg>
  <path d="${kicker.d}" fill="${kickerColor}"/>
  <path d="${title.d}" fill="${titleColor}"/>
  <rect x="${left}" y="108" width="${Math.ceil(title.width + 30)}" height="6" fill="${COLORS.cyan}"/>
</svg>
`;
}

const withDot = (color) => logoSvg.replace(/(<circle id="rec"[^>]*fill=")[^"]+/, `$1${color}`);
const render = (svg, size) => sharp(Buffer.from(svg), { density: Math.max(72, (72 * size) / 64) }).resize(size, size).png().toBuffer();

(async () => {
  fs.mkdirSync(p('build'), { recursive: true });
  fs.mkdirSync(p('src', 'assets'), { recursive: true });

  // For dark backgrounds (default) and for light backgrounds.
  const wordmark = buildWordmark({ title: COLORS.text, kicker: COLORS.muted });
  const wordmarkLight = buildWordmark({ title: COLORS.navy, kicker: '#5d6577' });
  fs.writeFileSync(p('assets', 'logo-wordmark.svg'), wordmark);
  fs.writeFileSync(p('assets', 'logo-wordmark-light.svg'), wordmarkLight);
  await sharp(Buffer.from(wordmark), { density: 288 }).png().toFile(p('assets', 'logo-wordmark.png'));
  await sharp(Buffer.from(wordmarkLight), { density: 288 }).png().toFile(p('assets', 'logo-wordmark-light.png'));

  await sharp(Buffer.from(logoSvg), { density: 288 }).resize(512, 512).png().toFile(p('build', 'icon.png'));
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(p('build', 'icon.ico'), await pngToIco(await Promise.all(icoSizes.map((s) => render(logoSvg, s)))));

  const states = { idle: '#5d6577', recording: COLORS.red, paused: '#ffb020' };
  for (const [state, color] of Object.entries(states)) {
    const svg = withDot(color);
    fs.writeFileSync(p('src', 'assets', `tray-${state}.png`), await render(svg, 16));
    fs.writeFileSync(p('src', 'assets', `tray-${state}@2x.png`), await render(svg, 32));
  }
  fs.copyFileSync(p('src', 'assets', 'tray-idle@2x.png'), p('src', 'assets', 'app.png'));
  fs.copyFileSync(p('assets', 'logo.svg'), p('src', 'overlay', 'logo.svg'));
  console.log('icons built');
})().catch((err) => { console.error(err); process.exit(1); });
