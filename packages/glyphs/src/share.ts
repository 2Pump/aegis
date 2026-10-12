/**
 * Sharing a wallet: the post text, the link-preview card (as SVG, rendered to PNG by the share function) and the small
 * page served at /s/<address> that gives X, Telegram and Discord their preview. One set of facts feeds all three.
 *
 * Privacy, same as the wallet page's share text: position types, risk level, which venues were read, block and time.
 * Never balances, health factors, liquidation prices or position sizes.
 */
import type { HullTemp, Tag } from '@aegis/pose';
import { BRAND } from './brand.js';
import { tagColor } from './core.js';
import { HULL_COPY, NO_TYPE_LABEL, RISK_LABEL, TAG_LABEL } from './labels.js';

export interface ShareFacts {
  /** checksummed address */
  address: string;
  tags: readonly Tag[];
  hullTemp: HullTemp;
  /** which venues were read successfully */
  venues: { tydro: boolean; nado: boolean };
  /** block the reading is from (null = unknown) */
  block?: number | null;
  /** when it was read, ms */
  at?: number | null;
}

export const SHARE = {
  /** path prefix of the share link (crawlers may fetch it; search engines don't index it) */
  PATH: '/s/',
  /** path prefix of the card image: /og/<address>.png */
  IMAGE_PATH: '/og/',
  WIDTH: 1200,
  HEIGHT: 630,
} as const;

export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shareUrl = (address: string, site: string = BRAND.siteUrl): string => `${site}${SHARE.PATH}${address}`;
export const shareImageUrl = (address: string, site: string = BRAND.siteUrl, bucket?: number): string =>
  `${site}${SHARE.IMAGE_PATH}${address}.png${bucket !== undefined ? `?h=${bucket}` : ''}`;

/** Position types to show: "near liquidation" is the risk line, so as a type it only appears when it's the only one. */
export function shareTypes(tags: readonly Tag[]): Tag[] {
  const t = tags.filter((x) => x !== 'EMPTY');
  const rest = t.filter((x) => x !== 'WOUNDED');
  return rest.length ? rest : t;
}
export const shareTypeText = (tags: readonly Tag[]): string => {
  const t = shareTypes(tags);
  return t.length ? t.map((x) => TAG_LABEL[x]).join(' + ') : NO_TYPE_LABEL;
};
export function shareVenueText(v: { tydro: boolean; nado: boolean }): string {
  if (v.tydro && v.nado) return 'Tydro and Nado read OK';
  if (v.tydro) return "Tydro read OK · Nado couldn't be read";
  if (v.nado) return "Nado read OK · Tydro couldn't be read";
  return "Tydro and Nado couldn't be read";
}

/** The post text: short lines (feeds collapse runs of spaces), then the link. */
export function shareText(f: ShareFacts, url: string): string {
  return [
    `${BRAND.display} · Ink wallet ${shortAddress(f.address)}`,
    `Position: ${shareTypeText(f.tags)}`,
    `Risk: ${RISK_LABEL[f.hullTemp]} · ${shareVenueText(f.venues)}`,
    url,
  ].join('\n');
}
/** Same text without the link (X's intent adds the link itself). */
export const shareTextNoUrl = (f: ShareFacts): string => shareText(f, '').trimEnd();

/* ───────────────────────── card (SVG, 1200 × 630) ───────────────────────── */

const RISK_COLOR: Record<HullTemp, string> = { NOMINAL: '#4CE0D2', ELEVATED: '#F5C14A', CRITICAL: '#FF4D4D', UNKNOWN: '#7D8B9B' };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** IBM Plex Mono advances 0.6 em per character, so widths are exact without measuring. */
const monoWidth = (s: string, size: number, spacing: number) => [...s].length * (size * 0.6 + spacing) - spacing;
const MARK_PATHS =
  '<circle cx="16" cy="16" r="13.5"/><path d="M16 9.5 L21.63 12.75 L21.63 19.25 L16 22.5 L10.37 19.25 L10.37 12.75 Z"/><path d="M16 9.5 L8.19 4.99 M21.63 12.75 L21.63 3.73 M21.63 19.25 L29.44 14.74 M16 22.5 L23.81 27.01 M10.37 19.25 L10.37 28.27 M10.37 12.75 L2.56 17.26"/>';
const mark = (x: number, y: number, size: number, color: string, stroke: number) =>
  `<g transform="translate(${x} ${y}) scale(${size / 32})" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round">${MARK_PATHS}</g>`;
const fmtWhen = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export function shareCardSvg(f: ShareFacts): string {
  const W = SHARE.WIDTH;
  const H = SHARE.HEIGHT;
  const rc = RISK_COLOR[f.hullTemp];
  const MONO = "'IBM Plex Mono'";
  const SANS = "'IBM Plex Sans'";
  // type chips, wrapped to the left column (max 2 rows)
  const fs = 19;
  const ls = 2.3;
  const chipW = (t: string) => monoWidth(t, fs, ls) + 30;
  const types = shareTypes(f.tags);
  const all = types.length ? types.map((t) => ({ text: TAG_LABEL[t].toUpperCase(), color: tagColor(t) })) : [{ text: NO_TYPE_LABEL.toUpperCase(), color: '#7D8B9B' }];
  // lay out up to two rows inside the left column; anything that doesn't fit becomes a "+N MORE" chip (never hidden silently)
  const place = (items: { text: string; color: string }[]) => {
    const out: Array<{ text: string; color: string; x: number; row: number; w: number }> = [];
    let x = 64;
    let r = 0;
    for (const c of items) {
      const w = chipW(c.text);
      if (x + w > 700 && x > 64) {
        if (r === 1) return null;
        r++;
        x = 64;
      }
      out.push({ ...c, x, row: r, w });
      x += w + 12;
    }
    return out;
  };
  let laid = place(all);
  for (let keep = all.length - 1; !laid && keep >= 1; keep--) laid = place([...all.slice(0, keep), { text: `+${all.length - keep} MORE`, color: '#7D8B9B' }]);
  const chipsLaid = laid ?? [];
  const row = chipsLaid.reduce((m, c) => Math.max(m, c.row), 0);
  const chips = chipsLaid.map(
    (c) =>
      `<rect x="${c.x}" y="${272 + c.row * 52}" width="${c.w.toFixed(1)}" height="40" fill="none" stroke="${c.color}" stroke-width="1.5"/>` +
      `<text x="${c.x + 15}" y="${299 + c.row * 52}" font-family="${MONO}" font-weight="600" font-size="${fs}" letter-spacing="${ls}" fill="${c.color}">${esc(c.text)}</text>`,
  );
  // a second chip row pushes the risk block down; the risk sentence then gives way so the venue line stays clear
  const shift = row * 48;
  const venue = (x: number, name: string, ok: boolean) =>
    `${ok ? `<circle cx="${x + 5}" cy="${H - 134}" r="4.5" fill="#CFD9E3"/>` : `<circle cx="${x + 5}" cy="${H - 134}" r="4.5" fill="none" stroke="#7D8B9B" stroke-width="1.5"/>`}` +
    `<text x="${x + 18}" y="${H - 128}" font-family="${MONO}" font-weight="500" font-size="17" letter-spacing="2" fill="${ok ? '#CFD9E3' : '#7D8B9B'}">${name}${ok ? '' : " — couldn't read"}</text>`;
  const tydroW = 18 + monoWidth(`TYDRO${f.venues.tydro ? '' : " — couldn't read"}`, 17, 2) + 30;
  const readAt = `${f.block ? `Read at block ${f.block.toLocaleString('en-US')}` : 'Read'}${f.at ? ` · ${fmtWhen(f.at)}` : ''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><radialGradient id="g" cx="0.78" cy="0.45" r="0.75"><stop offset="0" stop-color="#071016"/><stop offset="1" stop-color="#020305"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="#78BEC8" stroke-opacity="0.16"/>
<path d="M22 48 V22 H48" fill="none" stroke="#78BEC8" stroke-opacity="0.5"/><path d="M${W - 22} ${H - 48} V${H - 22} H${W - 48}" fill="none" stroke="#78BEC8" stroke-opacity="0.5"/>
${mark(64, 58, 30, '#CFD9E3', 2.4)}
<text x="108" y="81" font-family="${MONO}" font-weight="600" font-size="20" letter-spacing="6.4" fill="#CFD9E3">${esc(BRAND.name)}</text>
<text x="${(108 + monoWidth(BRAND.name, 20, 6.4) + 22).toFixed(0)}" y="81" font-family="${MONO}" font-weight="500" font-size="20" letter-spacing="6.4" fill="#657284">· INK WALLET</text>
<text x="64" y="200" font-family="${MONO}" font-weight="600" font-size="64" fill="#E6EDF3">${esc(shortAddress(f.address))}</text>
<text x="64" y="256" font-family="${MONO}" font-weight="500" font-size="15" letter-spacing="3.6" fill="#7D8B9B">POSITION TYPE</text>
${chips.join('\n')}
<text x="64" y="${362 + shift}" font-family="${MONO}" font-weight="500" font-size="15" letter-spacing="3.6" fill="#7D8B9B">RISK NOW</text>
<text x="64" y="${414 + shift}" font-family="${MONO}" font-weight="600" font-size="40" letter-spacing="6.4" fill="${rc}">${esc(RISK_LABEL[f.hullTemp].toUpperCase())}</text>
${row === 0 ? `<text x="64" y="450" font-family="${SANS}" font-size="20" fill="#9AA7B5">${esc(HULL_COPY[f.hullTemp])}</text>` : ''}
<circle cx="965" cy="285" r="150" fill="none" stroke="${rc}" stroke-opacity="0.9" stroke-width="3"${f.hullTemp === 'UNKNOWN' ? ' stroke-dasharray="6 10"' : ''}/>
<circle cx="965" cy="285" r="132" fill="none" stroke="#78BEC8" stroke-opacity="0.18"/>
${mark(865, 185, 200, f.hullTemp === 'NOMINAL' ? '#CFD9E3' : rc, 1.4)}
${venue(64, 'TYDRO', f.venues.tydro)}${venue(64 + tydroW, 'NADO', f.venues.nado)}
<text x="64" y="${H - 96}" font-family="${MONO}" font-size="16" letter-spacing="1.6" fill="#657284">${esc(readAt)}</text>
<text x="${W - 64}" y="${H - 128}" text-anchor="end" font-family="${MONO}" font-weight="600" font-size="16" letter-spacing="3.2" fill="#CFD9E3">${esc(`${new URL(BRAND.siteUrl).host.toUpperCase()} · ${BRAND.x.handle}`)}</text>
<text x="${W - 64}" y="${H - 96}" text-anchor="end" font-family="${MONO}" font-size="16" letter-spacing="1.6" fill="#657284">Read-only · not financial advice</text>
</svg>`;
}

/* ───────────────────────── the /s/<address> page ───────────────────────── */

/**
 * What crawlers read for the preview; people are sent straight on to the wallet page. `facts` null = the wallet
 * couldn't be read just now: the preview is the site's own card, and the page still forwards.
 */
export function sharePageHtml(o: { address: string; facts: ShareFacts | null; site?: string; imageBucket?: number }): string {
  const site = o.site ?? BRAND.siteUrl;
  const target = `${site}/hull/${o.address}`;
  const title = `${BRAND.display} · Ink wallet ${shortAddress(o.address)}`;
  const desc = o.facts
    ? `Position: ${shareTypeText(o.facts.tags)} · Risk: ${RISK_LABEL[o.facts.hullTemp]} · ${shareVenueText(o.facts.venues)}. Read-only — not financial advice.`
    : `Position type and liquidation risk for this Ink wallet on Tydro and Nado. Read-only — not financial advice.`;
  const image = o.facts ? shareImageUrl(o.address, site, o.imageBucket) : `${site}/og.png`;
  const m = (k: string, v: string, attr = 'property') => `<meta ${attr}="${k}" content="${esc(v)}" />`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${esc(title)}</title>
<meta name="robots" content="noindex" />
${m('description', desc, 'name')}
${m('og:type', 'website')}
${m('og:site_name', BRAND.name)}
${m('og:title', title)}
${m('og:description', desc)}
${m('og:url', shareUrl(o.address, site))}
${m('og:image', image)}
${m('og:image:width', String(SHARE.WIDTH))}
${m('og:image:height', String(SHARE.HEIGHT))}
${m('og:image:alt', `${title} — ${o.facts ? `${shareTypeText(o.facts.tags)}, risk ${RISK_LABEL[o.facts.hullTemp]}` : 'wallet card'}`)}
${m('twitter:card', 'summary_large_image', 'name')}
${m('twitter:site', BRAND.x.handle, 'name')}
${m('twitter:title', title, 'name')}
${m('twitter:description', desc, 'name')}
${m('twitter:image', image, 'name')}
<meta http-equiv="refresh" content="0; url=${esc(target)}" />
</head><body style="background:#020305;color:#cfd9e3;font-family:monospace">
<p>Opening <a href="${esc(target)}" style="color:#4ce0d2">${esc(title)}</a>…</p>
<script>location.replace(${JSON.stringify(target)})</script>
</body></html>`;
}
