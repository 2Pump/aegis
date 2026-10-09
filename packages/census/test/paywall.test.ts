import { describe, expect, it } from 'vitest';
import { encodeShip, type CensusSnapshot } from '../src/index.js';
import { makeDataHandler } from '../src/api/index.js';
import { apiUnlocked, effectiveAccess, isDataFileName, isFreeApiPath, isFreeFile, parseComp, siteUnlocked, type Access, type User } from '../src/accounts/index.js';

const A = '0x' + 'a'.repeat(40);
const SUB = '0x' + 'a'.repeat(40) + '69736f310000000000000000';
const census = {
  v: 1,
  chainId: 57073,
  generatedAt: '2026-10-09T00:00:00Z',
  block: 1000,
  rulesVersion: 'v1.2.0',
  discovery: { tydroScannedTo: 1000, nadoScannedTo: 1000, head: 1000, backfillComplete: true },
  sweep: { kind: 'incremental', reread: 1, carried: 0, ms: 1 },
  counts: { known: 1, drawn: 1, empty: 0, dark: 0, tydro: 0, nado: 1, wounded: 0 },
  mix: {},
  ships: [encodeShip({ address: A, primary: 'HOLD', tags: ['HOLD'], hullTemp: 'NOMINAL', band: '<1k', watch: false, venues: { tydro: false, nado: true }, readBlock: 999, woundedSince: null, wound: { tydro: false, nado: false }, correlatedLoop: false, correlatedNado: false, extraSubs: [SUB] })],
} as unknown as CensusSnapshot;
const FILES: Record<string, unknown> = { 'census.json': census, 'pressure.json': { p: 1 }, 'verification-log.json': { log: 1 }, 'history/accountability.json': { a: 1 } };

function data(paywall: boolean, access: Access, signedIn = access !== 'free') {
  let asked = 0;
  const h = makeDataHandler({
    read: async (n) => FILES[n] ?? null,
    paywall,
    access: async () => {
      asked++;
      return { signedIn, access };
    },
  });
  return { get: (path: string) => h({ method: 'GET', path }), asked: () => asked };
}

describe('paywall rules', () => {
  it('free files and API paths', () => {
    for (const f of ['verification-log.json', 'history/accountability.json', 'history/forecast-score.json']) expect(isFreeFile(f)).toBe(true);
    for (const f of ['census.json', 'pressure.json', 'history/index.json', 'history/agg/2026-10.json']) expect(isFreeFile(f)).toBe(false);
    for (const p of ['/', '/openapi.json', '/status', `/wallets/${A}`, '/performance', '/verification']) expect(isFreeApiPath(p)).toBe(true);
    for (const p of ['/pressure', '/stress', `/wallets/${A}/history`, `/wallets/${A}/scenario`, '/liquidations', '/events', '/carry']) expect(isFreeApiPath(p)).toBe(false);
  });
  it('file names: census names only — never known.json, a URL or ..', () => {
    expect(isDataFileName('history/agg/2026-10.json')).toBe(true);
    for (const bad of ['known.json', '../x.json', 'https://x/y.json', '/census.json', 'a//b.json', 'census.txt']) expect(isDataFileName(bad)).toBe(false);
  });
  it('plans: Pro opens the site, Desk opens the API too; complimentary accounts count as Desk', () => {
    expect([siteUnlocked('free'), siteUnlocked('pro'), siteUnlocked('desk')]).toEqual([false, true, true]);
    expect([apiUnlocked('free'), apiUnlocked('pro'), apiUnlocked('desk')]).toEqual([false, false, true]);
    const u: User = { id: 'x', email: 'owner@phrourax.com', createdAt: '', lastSignInAt: null, plan: null, paidUntil: null, sv: 1 };
    expect(effectiveAccess(u, Date.now(), parseComp(' Owner@Phrourax.com, other@x.co'))).toBe('desk');
    expect(effectiveAccess(u, Date.now(), parseComp(''))).toBe('free');
    expect(effectiveAccess(null, Date.now(), parseComp('owner@phrourax.com'))).toBe('free');
  });
});

describe('/data route', () => {
  it('paywall off: every census file to everyone, CDN-cacheable, no account lookup', async () => {
    const d = data(false, 'free');
    const r = await d.get('/data/census.json');
    expect(r.status).toBe(200);
    expect(r.headers['Cache-Control']).toContain('s-maxage');
    expect(d.asked()).toBe(0);
  });
  it('paywall on: paid files refused without a plan (402), never cached; free files still served', async () => {
    const d = data(true, 'free');
    const r = await d.get('/data/census.json');
    expect(r).toMatchObject({ status: 402, body: { error: { code: 'PAYMENT_REQUIRED', signedIn: false } } });
    expect(r.headers['Cache-Control']).toBe('no-store');
    expect((await d.get('/data/pressure.json')).status).toBe(402);
    const free = await d.get('/data/verification-log.json');
    expect(free.status).toBe(200);
    expect(free.headers['Cache-Control']).toContain('s-maxage');
  });
  it('paywall on, with a plan: served — but only to this browser (private, Vary: Cookie), never the CDN', async () => {
    const r = await data(true, 'pro').get('/data/census.json');
    expect(r.status).toBe(200);
    expect(r.headers['Cache-Control']).toBe('private, max-age=30');
    expect(r.headers.Vary).toBe('Cookie');
    expect(r.body).toBe(census);
  });
  it('one wallet’s subaccounts are free and small; unknown wallet → empty list; known.json and junk are 404', async () => {
    const d = data(true, 'free');
    expect((await d.get(`/data/subs/${A.toUpperCase().replace('0X', '0x')}`)).body).toEqual({ block: 1000, complete: true, subs: [SUB] });
    expect((await d.get(`/data/subs/0x${'b'.repeat(40)}`)).body).toEqual({ block: 1000, complete: true, subs: [] });
    for (const p of ['/data/known.json', '/data/../x.json', '/data/subs/0x12']) expect((await d.get(p)).status).toBe(404);
  });
  it('a missing file is 404, a store failure is 503 — never a crash', async () => {
    expect((await data(false, 'free').get('/data/history/agg/1999-01.json')).status).toBe(404);
    const broken = makeDataHandler({ read: async () => { throw new Error('blob down'); }, paywall: false, access: async () => ({ signedIn: false, access: 'free' }) });
    expect((await broken({ method: 'GET', path: '/data/census.json' })).status).toBe(503);
  });
});
