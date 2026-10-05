import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify, familyOf, type Book } from '@aegis/pose';
import { API, RateLimiter, handle, type ApiDeps, type ApiRequest } from '../src/api/index.js';
import { PressureAcc, encodeShip, emptyIndex, stressLevel, type AggPoint, type CensusSnapshot, type LedgerRecord, type PressureSnapshot } from '../src/index.js';

const NOW = Date.UTC(2026, 9, 5, 12);
const A = '0x' + '1'.repeat(40);
const B = '0x' + '2'.repeat(40);

function book(i: number, supply: number, debt: number): Book {
  const leg = (s: string, usd: number) => ({ symbol: s, ...familyOf(s), amount: usd / (s === 'WETH' ? 2000 : 1), usd, priceUsd: s === 'WETH' ? 2000 : 1, priceSource: 'FIXTURE' as const });
  return {
    address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    source: 'LIVE',
    tydro: { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { hf: (0.8 * supply) / debt, supplies: [leg('WETH', supply)], debts: [leg('USDC', debt)], totalCollateralUsd: supply, totalDebtUsd: debt, usdNet: supply - debt, liquidationThreshold: 0.8, notes: [] } },
    nado: { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { subaccounts: [], equityUsd: 0, spots: [], perps: [], maintenance: null, initial: null, unweighted: null, funding: [], notes: [] } },
    asOfBlock: 1,
    asOfTime: 0,
  } as Book;
}

function files(o: { censusAt?: number } = {}): Record<string, unknown> {
  const acc = new PressureAcc();
  for (let i = 0; i < 40; i++) {
    const b = book(i, 10_000, 5_000 + i * 50);
    acc.add(b, classify(b), '1–10k');
  }
  // two lonely wallets of one type → their counts must be suppressed
  const census: CensusSnapshot = {
    v: 1,
    chainId: 57073,
    generatedAt: new Date(o.censusAt ?? NOW - 600_000).toISOString(),
    block: 1000,
    rulesVersion: 'v1.2.0',
    discovery: { tydroScannedTo: 1000, nadoScannedTo: 1000, head: 1000, backfillComplete: true },
    sweep: { kind: 'incremental', reread: 10, carried: 0, ms: 1 },
    counts: { known: 2, drawn: 2, empty: 0, dark: 0, tydro: 2, nado: 0, wounded: 1 },
    mix: {},
    ships: [
      encodeShip({ address: A, primary: 'LEVERED', tags: ['LEVERED'], hullTemp: 'CRITICAL', band: '10–100k', watch: true, venues: { tydro: true, nado: false }, readBlock: 999, woundedSince: 900, wound: { tydro: true, nado: false }, correlatedLoop: false, correlatedNado: false, extraSubs: [] }),
      encodeShip({ address: B, primary: 'HOLD', tags: ['HOLD'], hullTemp: 'NOMINAL', band: '<1k', watch: false, venues: { tydro: true, nado: false }, readBlock: 999, woundedSince: null, wound: { tydro: false, nado: false }, correlatedLoop: false, correlatedNado: false, extraSubs: [] }),
    ],
  } as unknown as CensusSnapshot;
  const pts: AggPoint[] = [0, 1, 2].map((i) => ({ at: new Date(NOW - (3 - i) * 3_600_000).toISOString(), block: 997 + i, hash: `0xh${i}`, stress: i === 2 ? { level: 'CALM', confidence: 'NORMAL', version: 's', population: 40 } : null }) as unknown as AggPoint);
  const month = new Date(NOW).toISOString().slice(0, 7);
  const liq: LedgerRecord[] = Array.from({ length: 120 }, (_, i) => ({ id: `l${i}`, venue: 'tydro', at: NOW - i * 60_000, block: 900 - i, wallet: A, sizeBand: '1–10k', completeness: 'COMPLETE', aegis: { before: null } }) as unknown as LedgerRecord);
  return {
    'census.json': census,
    'pressure.json': acc.toSnapshot({ block: 990, at: new Date(NOW - 3_600_000).toISOString(), rulesVersion: 'v1.2.0' }),
    'history/index.json': { ...emptyIndex(), months: [month], ledgerMonths: [month], firstAt: new Date(NOW - 86_400_000).toISOString(), firstBlock: 1 },
    [`history/agg/${month}.json`]: { v: 1, kind: 'aegis-history-agg', chainId: 57073, month, points: pts },
    [`history/liq/${month}.json`]: { v: 1, kind: 'aegis-liquidations', month, records: liq },
    'history/oracle/latest.json': JSON.parse(readFileSync(new URL('../../../apps/web/e2e/fixtures/oracle-latest.json', import.meta.url), 'utf8')),
  };
}

function deps(f = files(), extra: Partial<ApiDeps> = {}): ApiDeps {
  return { get: async (n) => (n in f ? f[n] : null), now: () => NOW, limiter: new RateLimiter(), ...extra };
}
const req = (path: string, query: Record<string, string> = {}, o: Partial<ApiRequest> = {}): ApiRequest => ({ method: 'GET', path, query, ip: '1.2.3.4', headers: {}, ...o });
type Body = { schema: string; data: unknown; meta: Record<string, unknown>; page?: { nextCursor: string | null; returned: number; total: number }; error?: { code: string; status: number; message: string } };
const call = async (r: ApiRequest, d: ApiDeps = deps()) => {
  const res = await handle(r, d);
  return { ...res, b: res.body as Body };
};

describe('Public API · envelope', () => {
  it('schema version, versions, block, freshness and completeness metadata on every success', async () => {
    const r = await call(req('/status'));
    expect(r.status).toBe(200);
    expect(r.b.schema).toBe('aegis-api-1');
    expect(r.b.meta).toMatchObject({ apiVersion: API.VERSION, rulesVersion: 'v1.2.0', sourceBlock: 1000, freshness: 'FRESH', completeness: 'COMPLETE' });
    expect(r.b.meta.disclaimer).toMatch(/cannot move your funds/);
    const stale = await call(req('/status'), deps(files({ censusAt: NOW - 5 * 3_600_000 })));
    expect(stale.b.meta.freshness).toBe('STALE');
    expect(stale.b.meta.freshnessRule).toMatch(/more than 2 h old/);
  });

  it('error schema: code, status, message; documented codes only', async () => {
    const r = await call(req('/nope'));
    expect(r.status).toBe(404);
    expect(r.b.error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    const m = await call(req('/status', {}, { method: 'POST' }));
    expect(m.status).toBe(405);
    expect(m.b.error?.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('CORS: public read-only GET from any origin, no credentials; preflight answered', async () => {
    const r = await call(req('/status'));
    expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(r.headers['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
    expect(r.headers['Access-Control-Allow-Credentials']).toBeUndefined();
    expect((await call(req('/status', {}, { method: 'OPTIONS' }))).status).toBe(204);
    // webhook management is server-to-server: no CORS
    expect((await call(req('/webhooks', {}, { method: 'POST' }))).headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('Public API · validation and paging', () => {
  it('invalid address → 400 INVALID_ADDRESS; unknown wallet → 404 WALLET_NOT_IN_CENSUS', async () => {
    expect((await call(req('/wallets/0x123'))).b.error?.code).toBe('INVALID_ADDRESS');
    expect((await call(req('/wallets/not-an-address/history'))).b.error?.code).toBe('INVALID_ADDRESS');
    expect((await call(req(`/wallets/0x${'9'.repeat(40)}`))).b.error?.code).toBe('WALLET_NOT_IN_CENSUS');
  });

  it('invalid ranges → 400 INVALID_RANGE (order, future, over 90 days, garbage)', async () => {
    for (const q of [{ from: '2026-10-05', to: '2026-10-01' }, { to: '2027-01-01' }, { from: '2026-01-01', to: '2026-10-05' }, { from: 'yesterday' }] as Array<Record<string, string>>) {
      const r = await call(req('/liquidations', q));
      expect(r.status).toBe(400);
      expect(r.b.error?.code).toBe('INVALID_RANGE');
    }
  });

  it('pagination: bounded limit, opaque cursor, no overlap, tampered cursor rejected', async () => {
    const p1 = await call(req('/liquidations', { limit: '50' }));
    expect((p1.b.data as unknown[]).length).toBe(50);
    expect(p1.b.page?.total).toBe(120);
    const p2 = await call(req('/liquidations', { limit: '50', cursor: p1.b.page!.nextCursor! }));
    expect((p2.b.data as Array<{ id: string }>)[0]!.id).toBe('l50');
    const p3 = await call(req('/liquidations', { limit: '50', cursor: p2.b.page!.nextCursor! }));
    expect(p3.b.page?.nextCursor).toBeNull();
    expect((await call(req('/liquidations', { limit: '1000' }))).b.error?.code).toBe('INVALID_PARAMETER');
    expect((await call(req('/liquidations', { cursor: 'eyJvIjotMX0' }))).b.error?.code).toBe('INVALID_PARAMETER');
  });

  it('rate limiting: a burst over the class limit gets 429 with Retry-After and RateLimit headers', async () => {
    const d = deps(files(), { limiter: new RateLimiter({ light: 3, wallet: 2, live: 1, admin: 1 }) });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await handle(req('/status'), d)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const r = await handle(req('/status'), d);
    expect(r.headers['Retry-After']).toBeDefined();
    expect((r.body as Body).error?.code).toBe('RATE_LIMITED');
    // per IP: another client is unaffected
    expect((await handle(req('/status', {}, { ip: '5.6.7.8' }), d)).status).toBe(200);
  });
});

describe('Public API · privacy', () => {
  it('no wallet dump and no hit-list: no endpoint lists wallets or ranks them by closeness to liquidation', async () => {
    for (const p of ['/wallets', '/census', '/census.json', '/near', '/wounded', '/wallets/near', '/wallets/all', '/ships', '/watchlist', '/known']) {
      const r = await call(req(p));
      expect([400, 404]).toContain(r.status); // "near"/"all" aren't addresses → 400; the rest don't exist → 404
      expect(r.b.data).toBeUndefined();
    }
    const all = JSON.stringify((await call(req('/openapi.json'))).body);
    expect(all).not.toMatch(/"\/wallets"\s*:/);
  });

  it('single wallet: classification and risk only — no balances, health factor or liquidation price', async () => {
    const r = await call(req(`/wallets/${A}`));
    expect(r.status).toBe(200);
    expect(r.b.data).toMatchObject({ risk: 'CRITICAL', nearLiquidation: true, primaryType: 'LEVERED', sizeBand: '10–100k' });
    expect(JSON.stringify(r.b.data)).not.toMatch(/"(hf|healthFactor|usd|balance|collateral|debt|liquidationPrice)"/i);
  });

  it('aggregate privacy: Pressure counts of 1–4 are null, larger counts are returned', async () => {
    const r = await call(req('/pressure', { dir: 'ETH', pct: '30', material: '1k', dim: 't:LEVERED' }));
    expect(r.status).toBe(200);
    const c = (r.b.data as { counts: { population: number | null; now: Record<string, number | null> } }).counts;
    const vals = [c.population, ...Object.values(c.now)];
    for (const v of vals) expect(v === null || v === 0 || v >= 5).toBe(true);
    expect((await call(req('/pressure', { dir: 'NOPE' }))).b.error?.code).toBe('INVALID_PARAMETER');
    expect((await call(req('/pressure', { pct: '99' }))).b.error?.code).toBe('INVALID_PARAMETER');
  });

  it('the live scenario endpoint returns a level only, and refuses test wallets', async () => {
    const d = deps(files(), { readWallet: async () => book(1, 10_000, 7_000), fixtures: new Set([B]) });
    const r = await call(req(`/wallets/${A}/scenario`, { dir: 'ETH', pct: '20' }), d);
    expect(r.status).toBe(200);
    expect((r.b.data as { underScenario: string }).underScenario).toMatch(/SAFE|WATCH|NEAR|LIQUIDATABLE/);
    expect(JSON.stringify(r.b.data)).not.toMatch(/"(hf|usd|balance|threshold|pctToLiq)"/i);
    expect((await call(req(`/wallets/${B}/scenario`), d)).b.error?.code).toBe('FIXTURE_REJECTED');
    expect((await call(req(`/wallets/${A}/scenario`))).b.error?.code).toBe('NOT_ENABLED');
  });
});

describe('Public API · endpoints', () => {
  it('stress, history, oracles, events, cascades, liquidations, OpenAPI', async () => {
    expect((await call(req('/stress'))).b.data).toMatchObject({ level: expect.any(String) });
    expect((await call(req('/stress/history'))).b.data).toHaveLength(1);
    expect((await call(req('/oracles'))).b.data).toMatchObject({ kind: 'aegis-oracle-watch' });
    expect((await call(req('/oracles'))).b.data).not.toHaveProperty('state');
    expect((await call(req('/events', { type: 'cascade.detected' }))).status).toBe(200);
    expect((await call(req('/events', { type: 'wallet.nope' }))).b.error?.code).toBe('INVALID_PARAMETER');
    expect(((await call(req('/cascades'))).b.data as unknown[]).length).toBeGreaterThan(0);
    expect((await call(req(`/wallets/${A}/history`))).status).toBe(200);
    expect((await call(req('/carry'))).b.error?.code).toBe('NOT_RECORDED_YET');
    const o = (await call(req('/openapi.json'))).body as { openapi: string; paths: Record<string, unknown> };
    expect(o.openapi).toBe('3.1.0');
    expect(Object.keys(o.paths)).toContain('/wallets/{address}/scenario');
  });

  it('stress uses the same Nado coverage as the census and the Pressure page (confidence), and names the block hash', async () => {
    const f = files();
    const census = f['census.json'] as CensusSnapshot;
    (census as unknown as { coverage: unknown }).coverage = { share: { nadoOpenInterestLongs: 0.997, nadoOpenInterestShorts: 0.999 } };
    const ps = f['pressure.json'] as { block: number; at: string };
    ps.block = 999;
    ps.at = new Date(NOW - 3_600_000).toISOString();
    const r = await call(req('/stress'), deps(f));
    const want = stressLevel(f['pressure.json'] as PressureSnapshot, { nowMs: NOW, oiCoverage: 0.997 });
    expect((r.b.data as { confidence: string }).confidence).toBe(want.confidence);
    expect((r.b.data as { level: string }).level).toBe(want.level);
    expect(r.b.meta.sourceBlockHash).toBe('0xh2');
    // without coverage it says so (REDUCED) — never claims a coverage it didn't measure
    const g = files();
    expect(((await call(req('/stress'), deps(g))).b.data as { confidenceWhy: string[] }).confidenceWhy.join(' ')).toMatch(/coverage/i);
  });

  it('webhook management answers NOT_ENABLED until switched on, and limits body size', async () => {
    const r = await call(req('/webhooks', {}, { method: 'POST', body: '{}' }));
    expect(r.status).toBe(503);
    expect(r.b.error?.code).toBe('NOT_ENABLED');
    const big = await call(req('/webhooks', {}, { method: 'POST', body: 'x'.repeat(API.MAX_BODY_BYTES + 1) }));
    expect(big.b.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
