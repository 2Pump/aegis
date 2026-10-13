import { describe, expect, it } from 'vitest';
import { fetchNadoBook, parseMarketLiquidity } from '../src/nado-depth.js';

const E18 = 10n ** 18n;
const tick = (price: number, size: number) => [String(BigInt(Math.round(price * 100)) * E18 / 100n), String(BigInt(Math.round(size * 1000)) * E18 / 1000n)];

describe('Nado order book (market_liquidity)', () => {
  it('parses ticks as [priceX18, sizeX18] and sorts each side best-first', () => {
    const r = parseMarketLiquidity({ status: 'success', data: { bids: [tick(99, 1), tick(100, 2)], asks: [tick(102, 3), tick(101, 1.5)] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.bids.map((l) => l.price)).toEqual([100, 99]);
    expect(r.value.asks.map((l) => [l.price, l.size])).toEqual([[101, 1.5], [102, 3]]);
    expect(r.value.asks[0]!.raw).toBe(1_500_000_000_000_000_000n);
  });

  it('a reply that is not a success, or a level that is not a number, is a parse failure — never a half book', () => {
    expect(parseMarketLiquidity({ status: 'failure', error: 'x' }).ok).toBe(false);
    expect(parseMarketLiquidity({ status: 'success', data: { bids: [['abc', '1']], asks: [] } }).ok).toBe(false);
    expect(parseMarketLiquidity(null).ok).toBe(false);
  });

  it('a Cloudflare page is a refusal (recorded, not retried); a network error is a failure', async () => {
    const page = async () => new Response('<html>challenge</html>', { status: 403, headers: { 'content-type': 'text/html' } });
    expect(await fetchNadoBook(page, 2, 100)).toEqual({ ok: false, refused: true, reason: 'HTTP 403 (Cloudflare page)' });
    const down = async () => {
      throw new Error('ECONNRESET');
    };
    const r = await fetchNadoBook(down, 2, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused).toBe(false);
    let asked = '';
    const ok = async (u: string) => {
      asked = u;
      return new Response(JSON.stringify({ status: 'success', data: { bids: [tick(100, 1)], asks: [tick(101, 1)] } }), { headers: { 'content-type': 'application/json' } });
    };
    expect((await fetchNadoBook(ok, 4, 50)).ok).toBe(true);
    expect(asked).toBe('https://api.prod.nado.xyz/gateway/v1/query?type=market_liquidity&product_id=4&depth=50');
  });
});
