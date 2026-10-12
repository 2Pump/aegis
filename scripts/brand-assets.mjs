/**
 * Brand images in the site's palette (Ivory & Bank Green, packages/glyphs/src/palette.ts):
 *   apps/web/public/  favicon.svg · favicon.ico · icon-192.png · icon-512.png · apple-touch-icon.png · og.png
 *   brand/            x-banner.png (1500×500) · x-profile.png (400×400) · x-profile-ivory.png (alternative)
 * Run: node scripts/brand-assets.mjs   (uses the bundled IBM Plex fonts; no network)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'apps/web/package.json'));
const { Resvg } = require('@resvg/resvg-js');
const F = path.join(root, 'apps/web/api-assets/fonts/');
const fonts = ['IBMPlexMono-Regular.ttf', 'IBMPlexMono-Medium.ttf', 'IBMPlexMono-SemiBold.ttf', 'IBMPlexSans-Regular.ttf'].map((f) => F + f);
const png = (svg, width) => new Resvg(svg, { fitTo: width ? { mode: 'width', value: width } : { mode: 'original' }, font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Mono' } }).render().asPng();
const PUB = path.join(root, 'apps/web/public');
const BR = path.join(root, 'brand');
fs.mkdirSync(BR, { recursive: true });

const C = { page: '#F5F3EE', panel: '#FBFAF7', ink: '#1A1E22', dim: '#4E555C', faint: '#6B7279', accent: '#1F5C4A', hair: 'rgba(26,30,34,0.10)', hair2: 'rgba(26,30,34,0.28)' };
const mark = (cx, cy, d, color, sw = 2) => {
  const s = d / 32;
  return `<g transform="translate(${cx - d / 2} ${cy - d / 2}) scale(${s})" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round">
  <circle cx="16" cy="16" r="13.5"/>
  <path d="M16.00 9.50 L21.63 12.75 L21.63 19.25 L16.00 22.50 L10.37 19.25 L10.37 12.75 Z"/>
  <path d="M16.00 9.50 L8.19 4.99 M21.63 12.75 L21.63 3.73 M21.63 19.25 L29.44 14.74 M16.00 22.50 L23.81 27.01 M10.37 19.25 L10.37 28.27 M10.37 12.75 L2.56 17.26"/></g>`;
};
const brackets = (x0, y0, x1, y1, L, c) => `<g stroke="${c}" stroke-width="1.5" fill="none"><path d="M${x0} ${y0 + L} V${y0} H${x0 + L}"/><path d="M${x1 - L} ${y0} H${x1} V${y0 + L}"/><path d="M${x0} ${y1 - L} V${y1} H${x0 + L}"/><path d="M${x1 - L} ${y1} H${x1} V${y1 - L}"/></g>`;

/* ── icons: the mark in ivory on the green ── */
const iconSquare = (S, radius) => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" rx="${radius}" fill="${C.accent}"/>${mark(S / 2, S / 2, S * 0.7, C.page, 2.6)}</svg>`;
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="${C.accent}"/>${mark(16, 16, 27, C.page, 3.0)}</svg>`;
fs.writeFileSync(path.join(PUB, 'favicon.svg'), favicon.replace(/\n\s*/g, ''));
fs.writeFileSync(path.join(PUB, 'icon-192.png'), png(iconSquare(192, 40)));
fs.writeFileSync(path.join(PUB, 'icon-512.png'), png(iconSquare(512, 106)));
fs.writeFileSync(path.join(PUB, 'apple-touch-icon.png'), png(iconSquare(180, 0)));
// favicon.ico: one 32×32 and one 48×48 PNG inside an ICO container
const ico = (pngs) => {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(([size, buf], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size, e);
    head.writeUInt8(size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8);
    head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...pngs.map(([, b]) => b)]);
};
fs.writeFileSync(path.join(PUB, 'favicon.ico'), ico([[32, png(favicon, 32)], [48, png(favicon, 48)]]));

/* ── og.png 1200×630: the site's link preview ── */
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><radialGradient id="g" cx="0.3" cy="0.45" r="0.8"><stop offset="0" stop-color="${C.panel}"/><stop offset="1" stop-color="${C.page}"/></radialGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/>
<rect x="0.5" y="0.5" width="1199" height="629" fill="none" stroke="${C.hair}"/>
${brackets(24, 24, 1176, 606, 26, C.hair2)}
${mark(222, 315, 224, C.ink, 2.2)}
<g font-family="IBM Plex Mono">
  <text x="418" y="278" font-size="68" font-weight="600" fill="${C.ink}" letter-spacing="24">PHROURAX</text>
  <text x="420" y="333" font-size="22" font-weight="500" fill="${C.dim}" letter-spacing="7" xml:space="preserve">TYDRO · NADO · INK</text>
  <text x="420" y="410" font-size="26" fill="${C.ink}">See risk before it moves.</text>
  <text x="96" y="582" font-size="16" font-weight="500" fill="${C.faint}" letter-spacing="2.6">ON-CHAIN RISK INTELLIGENCE · READ-ONLY</text>
  <text x="1102" y="582" font-size="16" font-weight="500" fill="${C.faint}" text-anchor="end" letter-spacing="2.6">PHROURAX.COM</text>
</g>
<rect x="420" y="430" width="40" height="3" fill="${C.accent}"/>
</svg>`;
fs.writeFileSync(path.join(PUB, 'og.png'), png(og));

/* ── X banner 1500×500 (X crops ~60px top/bottom on phones; the profile photo covers the bottom-left) ── */
const W = 1500, H = 500, cx = 1180, cy = 250;
const rings = [70, 120, 175, 235, 300, 370].map((r, i) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${i === 2 ? 'rgba(31,92,74,0.55)' : 'rgba(26,30,34,0.10)'}" stroke-width="${i === 2 ? 1.5 : 1}"/>`).join('');
const ticks = Array.from({ length: 120 }, (_, i) => {
  const a = (i / 120) * Math.PI * 2, r1 = 235, r2 = i % 10 === 0 ? 250 : 242;
  return `<line x1="${(cx + r1 * Math.cos(a)).toFixed(1)}" y1="${(cy + r1 * Math.sin(a)).toFixed(1)}" x2="${(cx + r2 * Math.cos(a)).toFixed(1)}" y2="${(cy + r2 * Math.sin(a)).toFixed(1)}" stroke="rgba(26,30,34,${i % 10 === 0 ? 0.32 : 0.13})" stroke-width="1"/>`;
}).join('');
const sweep = (() => {
  const r = 370, a0 = -0.95, a1 = -0.35;
  const p = (a) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  return `<path d="M${cx} ${cy} L${p(a0)} A${r} ${r} 0 0 1 ${p(a1)} Z" fill="url(#sw)"/><line x1="${cx}" y1="${cy}" x2="${(cx + r * Math.cos(a1)).toFixed(1)}" y2="${(cy + r * Math.sin(a1)).toFixed(1)}" stroke="rgba(31,92,74,0.6)" stroke-width="1.5"/>`;
})();
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <radialGradient id="glow" cx="${cx}" cy="${cy}" r="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${C.panel}"/><stop offset="1" stop-color="${C.page}"/></radialGradient>
  <linearGradient id="sw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(31,92,74,0)"/><stop offset="1" stop-color="rgba(31,92,74,0.10)"/></linearGradient>
  <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0 H0 V50" fill="none" stroke="rgba(26,30,34,0.035)" stroke-width="1"/></pattern>
</defs>
<rect width="${W}" height="${H}" fill="${C.page}"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<rect width="${W}" height="${H}" fill="url(#grid)"/>
${rings}${ticks}${sweep}
${mark(cx, cy, 150, C.ink, 1.6)}
<line x1="${cx}" y1="0" x2="${cx}" y2="${cy - 260}" stroke="rgba(26,30,34,0.10)"/>
<line x1="${cx}" y1="${cy + 260}" x2="${cx}" y2="${H}" stroke="rgba(26,30,34,0.10)"/>
<g font-family="IBM Plex Mono">
  <text x="430" y="212" font-size="64" font-weight="600" fill="${C.ink}" letter-spacing="25">PHROURAX</text>
  <text x="432" y="258" font-size="19" font-weight="500" fill="${C.dim}" letter-spacing="7" xml:space="preserve">TYDRO · NADO · INK</text>
  <text x="432" y="312" font-size="26" font-weight="400" fill="${C.ink}">See risk before it moves.</text>
  <text x="432" y="352" font-size="15" font-weight="500" fill="${C.faint}" letter-spacing="2.4">ON-CHAIN RISK INTELLIGENCE · READ-ONLY</text>
  <text x="${W - 60}" y="${H - 72}" font-size="15" font-weight="500" fill="${C.dim}" text-anchor="end" letter-spacing="2.4">PHROURAX.COM</text>
</g>
<rect x="430" y="370" width="40" height="3" fill="${C.accent}"/>
${brackets(24, 24, W - 24, H - 24, 26, C.hair2)}
</svg>`;
fs.writeFileSync(path.join(BR, 'x-banner.png'), png(banner));

/* ── X profile photo 400×400 (shown as a circle) ── */
const P = 400;
const pfp = `<svg xmlns="http://www.w3.org/2000/svg" width="${P}" height="${P}" viewBox="0 0 ${P} ${P}"><rect width="${P}" height="${P}" fill="${C.accent}"/>${mark(200, 200, 230, C.page, 2)}</svg>`;
const pfpIvory = `<svg xmlns="http://www.w3.org/2000/svg" width="${P}" height="${P}" viewBox="0 0 ${P} ${P}"><rect width="${P}" height="${P}" fill="${C.page}"/>${mark(200, 200, 230, C.ink, 2)}</svg>`;
fs.writeFileSync(path.join(BR, 'x-profile.png'), png(pfp));
fs.writeFileSync(path.join(BR, 'x-profile-ivory.png'), png(pfpIvory));
console.log('brand assets written: apps/web/public (favicon.svg, favicon.ico, icon-192, icon-512, apple-touch-icon, og.png) and brand/ (x-banner, x-profile, x-profile-ivory)');
