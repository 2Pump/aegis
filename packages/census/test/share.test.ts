import { describe, expect, it, vi } from 'vitest';
import type { Book } from '@aegis/pose';
import carry from '../../../fixtures/carry.json';
import { makeShareHandler, SHARE_API } from '../src/api/index.js';

const A = '0x7BFEe91193d9Df2Ac0bFe90191D40F23c773C060';
const book = { ...(carry as unknown as Book), address: A, asOfBlock: 57_812_440 } as Book;
const PNG = new Uint8Array([137, 80, 78, 71]);
function setup(o: { read?: () => Promise<Book | null>; render?: () => Uint8Array; now?: () => number } = {}) {
  const read = vi.fn(o.read ?? (async () => book));
  const render = vi.fn(o.render ?? (() => PNG));
  let t = Date.parse('2026-10-07T14:05:00Z');
  const h = makeShareHandler({ readWallet: read, render, now: o.now ?? (() => t), fixtures: new Set(['0x00000000000000000000000000000000000ae601']) });
  return { h, read, render, tick: (ms: number) => (t += ms) };
}
const ip = '1.2.3.4';

describe('share endpoints — /s/<address> page and /og/<address>.png card', () => {
  it('page: preview tags, noindex, forwards to the wallet page; image: the card PNG — one live read serves both', async () => {
    const { h, read, render } = setup();
    const p = await h({ kind: 'page', param: A, ip });
    expect(p.status).toBe(200);
    expect(p.headers['Content-Type']).toContain('text/html');
    expect(p.headers['X-Robots-Tag']).toBe('noindex');
    expect(p.headers['Cache-Control']).toContain('s-maxage=600');
    const html = String(p.body);
    expect(html).toContain('summary_large_image');
    expect(html).toContain(`https://phrourax.com/og/${A}.png?h=`);
    expect(html).toContain(`url=https://phrourax.com/hull/${A}`);
    expect(html).not.toMatch(/\$\d/);
    const i = await h({ kind: 'image', param: `${A}.png`, ip });
    expect(i.status).toBe(200);
    expect(i.headers['Content-Type']).toBe('image/png');
    expect(i.headers['Cache-Control']).toContain('s-maxage=3600');
    expect(i.body).toBe(PNG);
    expect(read).toHaveBeenCalledTimes(1);
    const svg = (render.mock.calls as unknown as string[][])[0]![0]!;
    expect(svg).toContain('57,812,440');
    expect(svg).toContain('0x7BFE…C060');
  });
  it('addresses are checksummed; junk and test wallets go to the site home / the site card', async () => {
    const { h, read } = setup();
    const p = await h({ kind: 'page', param: A.toLowerCase(), ip });
    expect(String(p.body)).toContain(`/s/${A}`);
    expect(await h({ kind: 'page', param: 'nope', ip })).toMatchObject({ status: 302, headers: { Location: 'https://phrourax.com/' } });
    expect(await h({ kind: 'image', param: '0x123.png', ip })).toMatchObject({ status: 302, headers: { Location: 'https://phrourax.com/og.png' } });
    expect(await h({ kind: 'page', param: '0x00000000000000000000000000000000000ae601', ip })).toMatchObject({ status: 302 });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('a failed read: the page shows the site card (short cache), the image falls back, and it is retried soon', async () => {
    let fail = true;
    const { h, read, tick } = setup({ read: async () => (fail ? Promise.reject(new Error('rpc down')) : book) });
    const p = await h({ kind: 'page', param: A, ip });
    expect(String(p.body)).toContain('<meta property="og:image" content="https://phrourax.com/og.png" />');
    expect(p.headers['Cache-Control']).toContain('s-maxage=60');
    expect(await h({ kind: 'image', param: `${A}.png`, ip })).toMatchObject({ status: 302, headers: { Location: 'https://phrourax.com/og.png' } });
    fail = false;
    tick(SHARE_API.FAIL_TTL_MS + 1);
    expect((await h({ kind: 'image', param: `${A}.png`, ip })).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('a renderer failure falls back to the site card instead of an error', async () => {
    const { h } = setup({ render: () => { throw new Error('no fonts'); } });
    expect(await h({ kind: 'image', param: `${A}.png`, ip })).toMatchObject({ status: 302, headers: { Location: 'https://phrourax.com/og.png' } });
  });
  it('rate-limited per IP: 30 card renders a minute', async () => {
    const { h } = setup();
    for (let n = 0; n < 30; n++) expect((await h({ kind: 'image', param: `${A}.png`, ip })).status).toBe(200);
    const r = await h({ kind: 'image', param: `${A}.png`, ip });
    expect(r.status).toBe(429);
    expect(Number(r.headers['Retry-After'])).toBeGreaterThan(0);
    expect((await h({ kind: 'image', param: `${A}.png`, ip: '5.6.7.8' })).status).toBe(200);
  });
});
