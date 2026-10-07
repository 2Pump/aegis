/**
 * PUBLIC RISK API (pure handler; no framework, no IO of its own) — `/api/v1`, `api-1.0.0`. Release 5.
 *
 * Read-only. Everything is served from the files the hourly census already publishes (and, for one endpoint, a single
 * live wallet read). Deliberately absent: any endpoint that lists wallets, ranks them by closeness to liquidation, or
 * returns balances, health factors or liquidation prices. Small counts (1–4) in aggregates are suppressed.
 *
 * The Vercel function (apps/web/api-src/v1.ts) only adapts HTTP to `handle()`; the tests call `handle()` directly.
 */
import { DIRECTIONS, RULES, SCENARIO_ENGINE_VERSION, classify, directionScenario, thresholds, confidenceOf, canBeLiquidated, type Book, type Tag } from '@aegis/pose';
import { parseAddress } from '@aegis/ink-io';
import { CARRY_LATEST, type CarryFile } from '../carry.js';
import { changesPath, type ChangeRecord, type ChangesFile } from '../changes.js';
import { inkEvents, INK_EVENT_TYPES } from '../events.js';
import { FORECAST_SCORE_PATH } from '../forecast.js';
import { INDEX_PATH, aggPath, isAggFile, isHistoryIndex, isWalletFile, monthsBetween, shardOf, walletPath, walletTimeline, type AggPoint, type HistoryIndex, type WalletFile } from '../history.js';
import { ACCOUNT_PATH, cascades, isLedgerFile, ledgerPath, type LedgerRecord } from '../ledger.js';
import { ORACLE_LATEST, type OracleWatch } from '../oracle.js';
import { MATERIAL, PRIVACY_MIN_CELL, queryPressure, stressLevel, type Material, type PressureSnapshot } from '../pressure.js';
import { latestChecks, type VerificationRecord } from '../verify.js';
import { decodeShip, type CensusSnapshot } from '../index.js';
import { openapi } from './openapi.js';
import { BRAND } from '@aegis/glyphs';

export const API = {
  VERSION: 'api-1.0.0',
  SCHEMA: 'phrourax-api-1',
  PREFIX: '/api/v1',
  MAX_LIMIT: 100,
  DEFAULT_LIMIT: 50,
  MAX_RANGE_DAYS: 90,
  MAX_BODY_BYTES: 8 * 1024,
  /** requests per minute per client IP, per class */
  LIMITS: { light: 120, wallet: 30, live: 6, admin: 20 } as const,
  /** hours after which a source is reported STALE */
  FRESH_H: { census: 2, pressure: 6, oracle: 3, carry: 3, history: 2, ledger: 3, params: 3, performance: 26, verification: 8 } as const,
} as const;

export const DISCLAIMER =
  `${BRAND.disclaimer} Observations of public on-chain data, which can be late, incomplete or wrong.`;

export type LimitClass = keyof typeof API.LIMITS;
export interface ApiRequest {
  method: string;
  /** path after /api/v1, e.g. "/wallets/0xabc" */
  path: string;
  query: Record<string, string | undefined>;
  ip: string;
  headers: Record<string, string | undefined>;
  body?: string;
}
export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** What a webhook management handler looks like (webhooks/api.ts); null = webhooks not enabled. */
export type WebhookHandler = (req: ApiRequest, sub: string[]) => Promise<ApiResponse>;

export interface ApiDeps {
  /** a census file by its store name ('census.json', 'history/…'); null = not there */
  get(name: string): Promise<unknown | null>;
  now(): number;
  limiter: RateLimiter;
  /** one live wallet read (scenario endpoint); undefined = not available in this deployment */
  readWallet?: (address: `0x${string}`) => Promise<Book | null>;
  webhooks?: WebhookHandler | null;
  fixtures?: ReadonlySet<string>;
}

/* ───────────────────────── rate limiting (token bucket, per instance) ───────────────────────── */

export class RateLimiter {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private limits: Record<string, number> = API.LIMITS) {}
  /** take one token; returns remaining and seconds until a token is back */
  take(key: string, cls: string, nowMs: number): { ok: boolean; limit: number; remaining: number; resetS: number } {
    const limit = this.limits[cls] ?? 60;
    const k = `${cls}|${key}`;
    const rate = limit / 60_000;
    const cur = this.b.get(k) ?? { tokens: limit, at: nowMs };
    const tokens = Math.min(limit, cur.tokens + (nowMs - cur.at) * rate);
    const ok = tokens >= 1;
    const next = { tokens: ok ? tokens - 1 : tokens, at: nowMs };
    this.b.set(k, next);
    if (this.b.size > 50_000) for (const [kk, v] of this.b) if (nowMs - v.at > 120_000) this.b.delete(kk);
    return { ok, limit, remaining: Math.floor(next.tokens), resetS: ok ? 0 : Math.max(1, Math.ceil((1 - next.tokens) / rate / 1000)) };
  }
}

/* ───────────────────────── envelope, errors ───────────────────────── */

export type Freshness = 'FRESH' | 'STALE' | 'UNKNOWN';
export interface Meta {
  schema: string;
  apiVersion: string;
  rulesVersion: string;
  engineVersion: string;
  /** the data's own version(s), e.g. oracle-1.0.0 */
  dataVersion: string | null;
  source: string;
  sourceBlock: number | null;
  sourceBlockHash: string | null;
  generatedAt: string | null;
  servedAt: string;
  ageSeconds: number | null;
  freshness: Freshness;
  freshnessRule: string;
  completeness: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
  completenessNotes: string[];
  approximate: boolean;
  coverage: Record<string, number> | null;
  privacy: string[];
  disclaimer: string;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
const JSON_H = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };

export const ERRORS = {
  BAD_REQUEST: 400,
  INVALID_ADDRESS: 400,
  INVALID_RANGE: 400,
  INVALID_PARAMETER: 400,
  FIXTURE_REJECTED: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  WALLET_NOT_IN_CENSUS: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  NOT_ENABLED: 503,
  NOT_RECORDED_YET: 503,
} as const;
export type ErrorCode = keyof typeof ERRORS;

export class ApiError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}
export const errorBody = (code: ErrorCode, message: string, details?: Record<string, unknown>) => ({ schema: API.SCHEMA, error: { code, status: ERRORS[code], message, ...(details ? { details } : {}) }, disclaimer: DISCLAIMER });

function meta(o: Partial<Meta> & { source: string; generatedAt: string | null; freshH: number | null; now: number }): Meta {
  const t = o.generatedAt ? Date.parse(o.generatedAt) : NaN;
  const age = Number.isFinite(t) ? Math.max(0, Math.round((o.now - t) / 1000)) : null;
  return {
    schema: API.SCHEMA,
    apiVersion: API.VERSION,
    rulesVersion: o.rulesVersion ?? RULES.RULES_VERSION,
    engineVersion: o.engineVersion ?? SCENARIO_ENGINE_VERSION,
    dataVersion: o.dataVersion ?? null,
    source: o.source,
    sourceBlock: o.sourceBlock ?? null,
    sourceBlockHash: o.sourceBlockHash ?? null,
    generatedAt: o.generatedAt,
    servedAt: new Date(o.now).toISOString(),
    ageSeconds: age,
    freshness: age === null || o.freshH === null ? 'UNKNOWN' : age / 3600 <= o.freshH ? 'FRESH' : 'STALE',
    freshnessRule: o.freshH === null ? 'not applicable' : `STALE when the source is more than ${o.freshH} h old`,
    completeness: o.completeness ?? 'COMPLETE',
    completenessNotes: o.completenessNotes ?? [],
    approximate: o.approximate ?? false,
    coverage: o.coverage ?? null,
    privacy: o.privacy ?? ['no balances, health factors or liquidation prices', `aggregate counts of 1–${PRIVACY_MIN_CELL - 1} are suppressed (null)`],
    disclaimer: DISCLAIMER,
  };
}

/* ───────────────────────── validation ───────────────────────── */

export function parseRange(q: ApiRequest['query'], now: number, defDays: number, maxDays: number = API.MAX_RANGE_DAYS): { from: number; to: number } {
  const t = (s: string | undefined, name: string): number | null => {
    if (s === undefined || s === '') return null;
    const n = /^\d{10,13}$/.test(s) ? Number(s.length === 10 ? Number(s) * 1000 : s) : Date.parse(s);
    if (!Number.isFinite(n)) throw new ApiError('INVALID_RANGE', `${name} must be an ISO date or a unix time`, { [name]: s });
    return n;
  };
  const to = t(q.to, 'to') ?? now;
  const from = t(q.from, 'from') ?? to - defDays * 86_400_000;
  if (from >= to) throw new ApiError('INVALID_RANGE', '`from` must be before `to`');
  if (to > now + 3_600_000) throw new ApiError('INVALID_RANGE', '`to` is in the future');
  if (to - from > maxDays * 86_400_000) throw new ApiError('INVALID_RANGE', `a range can span at most ${maxDays} days`, { maxDays });
  return { from, to };
}

export function parsePage(q: ApiRequest['query']): { offset: number; limit: number } {
  const limit = q.limit === undefined ? API.DEFAULT_LIMIT : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > API.MAX_LIMIT) throw new ApiError('INVALID_PARAMETER', `limit must be an integer 1–${API.MAX_LIMIT}`);
  let offset = 0;
  if (q.cursor) {
    try {
      const o = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as { o?: unknown };
      if (!Number.isInteger(o.o) || (o.o as number) < 0 || (o.o as number) > 1_000_000) throw new Error();
      offset = o.o as number;
    } catch {
      throw new ApiError('INVALID_PARAMETER', 'cursor is not one this API issued');
    }
  }
  return { offset, limit };
}
const cursorOf = (o: number) => Buffer.from(JSON.stringify({ o }), 'utf8').toString('base64url');
function page<T>(items: readonly T[], q: ApiRequest['query']) {
  const { offset, limit } = parsePage(q);
  const slice = items.slice(offset, offset + limit);
  return { items: slice, page: { total: items.length, limit, returned: slice.length, nextCursor: offset + limit < items.length ? cursorOf(offset + limit) : null } };
}

function address(raw: string | undefined): `0x${string}` {
  const r = parseAddress(raw ?? '');
  if (!r.ok) throw new ApiError('INVALID_ADDRESS', 'not a valid 0x address (40 hex characters)', { address: raw ?? null });
  return r.value.lower;
}

const suppress = (n: number) => (n > 0 && n < PRIVACY_MIN_CELL ? null : n);

/* ───────────────────────── data access ───────────────────────── */

async function index(d: ApiDeps): Promise<HistoryIndex | null> {
  const x = await d.get(INDEX_PATH);
  return isHistoryIndex(x) ? x : null;
}
async function aggPoints(d: ApiDeps, idx: HistoryIndex | null, from: number, to: number): Promise<AggPoint[]> {
  if (!idx) return [];
  const months = monthsBetween(from, to, 4).filter((m) => idx.months.includes(m));
  const files = await Promise.all(months.map((m) => d.get(aggPath(m))));
  return files.flatMap((f) => (isAggFile(f) ? f.points : [])).filter((p) => Date.parse(p.at) >= from && Date.parse(p.at) <= to);
}
async function ledger(d: ApiDeps, idx: HistoryIndex | null, from: number, to: number): Promise<LedgerRecord[]> {
  const months = monthsBetween(from, to, 4).filter((m) => (idx?.ledgerMonths ?? []).includes(m));
  const files = await Promise.all(months.map((m) => d.get(ledgerPath(m))));
  return files.flatMap((f) => (isLedgerFile(f) ? f.records : [])).filter((r) => r.at >= from && r.at <= to);
}
async function changes(d: ApiDeps, idx: HistoryIndex | null, from: number, to: number): Promise<ChangeRecord[]> {
  const months = monthsBetween(from, to, 4).filter((m) => (idx?.changeMonths ?? []).includes(m));
  const files = await Promise.all(months.map((m) => d.get(changesPath(m))));
  return files.flatMap((f) => ((f as ChangesFile)?.kind === 'aegis-changes' ? (f as ChangesFile).records : [])).filter((r) => r.between.toAt >= from && r.between.toAt <= to);
}
async function census(d: ApiDeps): Promise<CensusSnapshot> {
  const c = (await d.get('census.json')) as CensusSnapshot | null;
  if (!c || !Array.isArray(c.ships)) throw new ApiError('NOT_RECORDED_YET', 'the census has not been published yet');
  return c;
}
async function pressure(d: ApiDeps): Promise<PressureSnapshot> {
  const p = (await d.get('pressure.json')) as PressureSnapshot | null;
  if (!p || typeof p.hist !== 'object') throw new ApiError('NOT_RECORDED_YET', 'the Pressure Map has not been built yet (it is rebuilt by each full scan)');
  return p;
}
const hashAt = async (d: ApiDeps, idx: HistoryIndex | null, block: number, at: string | null): Promise<string | null> => {
  if (!at) return null;
  const t = Date.parse(at);
  const pts = await aggPoints(d, idx, t - 3_600_000, t + 3_600_000).catch(() => []);
  return pts.find((p) => p.block === block)?.hash ?? null;
};

/* ───────────────────────── routes ───────────────────────── */

type Route = { pattern: RegExp; cls: LimitClass; cache: string; run: (req: ApiRequest, m: RegExpMatchArray, d: ApiDeps) => Promise<{ data: unknown; meta: Meta; extra?: Record<string, unknown> }> };
const CACHE_AGG = 'public, max-age=30, s-maxage=60, stale-while-revalidate=300';
const CACHE_WALLET = 'public, max-age=30, s-maxage=60';
const CACHE_STATIC = 'public, max-age=300, s-maxage=3600';

const ROUTES: Route[] = [
  {
    pattern: /^\/status$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (_q, _m, d) => {
      const c = await census(d);
      const idx = await index(d);
      const now = d.now();
      return {
        data: {
          chainId: c.chainId,
          block: c.block,
          generatedAt: c.generatedAt,
          sweep: c.sweep,
          counts: { known: c.counts.known, drawn: c.counts.drawn, empty: c.counts.empty, dark: c.counts.dark, nearLiquidation: c.counts.wounded },
          discovery: c.discovery,
          recording: { since: idx?.firstAt ?? null, months: idx?.months.length ?? 0, ledgerMonths: idx?.ledgerMonths?.length ?? 0 },
        },
        meta: meta({ source: 'census.json (hourly census)', generatedAt: c.generatedAt, freshH: API.FRESH_H.census, now, sourceBlock: c.block, sourceBlockHash: await hashAt(d, idx, c.block, c.generatedAt), rulesVersion: c.rulesVersion, completeness: c.sweep.complete === false ? 'PARTIAL' : 'COMPLETE', completenessNotes: c.sweep.complete === false ? ['a full sweep is paused mid-way; unread wallets keep their previous reading'] : [], coverage: coverageShares(c) }),
      };
    },
  },
  {
    pattern: /^\/coverage$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (_q, _m, d) => {
      const c = await census(d);
      return {
        data: { coverage: c.coverage ?? null, note: 'Shares of each protocol’s own on-chain totals that the known wallets add up to, measured on the last full sweep that read every wallet at one block.' },
        meta: meta({ source: 'census.json → coverage', generatedAt: c.generatedAt, freshH: API.FRESH_H.census, now: d.now(), sourceBlock: c.block, coverage: coverageShares(c), completeness: c.coverage ? 'COMPLETE' : 'UNAVAILABLE' }),
      };
    },
  },
  {
    pattern: /^\/stress$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (_q, _m, d) => {
      const p = await pressure(d);
      const c = (await d.get('census.json').catch(() => null)) as CensusSnapshot | null;
      // the same Nado open-interest coverage the census and the Pressure page use (else confidence would read REDUCED)
      const s = stressLevel(p, { nowMs: d.now(), oiCoverage: c ? oiCoverage(c) : null });
      const idx = await index(d);
      return {
        data: { level: s.level, confidence: s.confidence, confidenceWhy: s.confidenceWhy, why: s.why, inputs: { population: s.inputs.population, nearShare: s.inputs.near, near10Share: s.inputs.near10, liq10Share: s.inputs.liq10 } },
        meta: meta({ source: 'pressure.json (last full scan)', generatedAt: p.at, freshH: API.FRESH_H.pressure, now: d.now(), sourceBlock: p.block, sourceBlockHash: await hashAt(d, idx, p.block, p.at), rulesVersion: p.rulesVersion, engineVersion: p.engine, dataVersion: s.version, approximate: p.population.approximate > 0, coverage: c ? coverageShares(c) : null }),
      };
    },
  },
  {
    pattern: /^\/stress\/history$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (q, _m, d) => {
      const now = d.now();
      const r = parseRange(q.query, now, 30);
      const idx = await index(d);
      if (!idx) throw new ApiError('NOT_RECORDED_YET', 'nothing recorded yet');
      const pts = (await aggPoints(d, idx, r.from, r.to)).filter((p) => p.stress).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const pg = page(pts.map((p) => ({ at: p.at, block: p.block, blockHash: p.hash, level: p.stress!.level, confidence: p.stress!.confidence, version: p.stress!.version, reorg: p.reorg ?? false })), q.query);
      return { data: pg.items, extra: { page: pg.page, range: { from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString() } }, meta: meta({ source: 'history/agg (Flight Recorder)', generatedAt: pts[0]?.at ?? null, freshH: 6, now }) };
    },
  },
  {
    pattern: /^\/pressure$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (q, _m, d) => {
      const p = await pressure(d);
      const dir = DIRECTIONS.find((x) => x.id === (q.query.dir ?? 'CRYPTO'));
      if (!dir) throw new ApiError('INVALID_PARAMETER', `dir must be one of ${DIRECTIONS.map((x) => x.id).join(', ')}`);
      const sign = (q.query.sign ?? 'down') as 'down' | 'up';
      if (sign !== 'down' && sign !== 'up') throw new ApiError('INVALID_PARAMETER', 'sign must be down or up');
      if (sign === 'up' && dir.downOnly) throw new ApiError('INVALID_PARAMETER', `${dir.id} is modelled for falls only`);
      const pct = Number(q.query.pct ?? 10);
      if (!Number.isInteger(pct) || pct < 0 || pct > p.maxPct) throw new ApiError('INVALID_PARAMETER', `pct must be an integer 0–${p.maxPct}`);
      const material = (q.query.material ?? '1k') as Material;
      if (!MATERIAL.includes(material)) throw new ApiError('INVALID_PARAMETER', `material must be one of ${MATERIAL.join(', ')}`);
      const dim = q.query.dim ?? '*';
      if (!/^(\*|v:(tydro|nado|both)|t:[A-Z-]{3,20})$/.test(dim)) throw new ApiError('INVALID_PARAMETER', 'dim must be *, v:tydro|nado|both or t:<TYPE>');
      const r = queryPressure(p, { dir: dir.id, sign, pct, material, dim });
      const counts = {
        population: suppress(r.population),
        now: { safe: suppress(r.now.S), watch: suppress(r.now.W), near: suppress(r.now.N), liquidatable: suppress(r.now.L) },
        underScenario: { safeToWatch: suppress(r.safeToWatch), safeToNear: suppress(r.safeToNear), watchToNear: suppress(r.watchToNear), newlyLiquidatable: suppress(r.newlyLiquidatable), nearOrWorse: suppress(r.nearUnder), liquidatable: suppress(r.liquidatableUnder), affected: suppress(r.affected) },
      };
      return {
        data: { scenario: { dir: dir.id, sign, pct, material, dim }, counts, note: 'A simulation of wallet counts if prices moved — not a prediction. Counts of 1–4 are suppressed for privacy.' },
        meta: meta({ source: 'pressure.json (last full scan)', generatedAt: p.at, freshH: API.FRESH_H.pressure, now: d.now(), sourceBlock: p.block, rulesVersion: p.rulesVersion, engineVersion: p.engine, approximate: true, completenessNotes: [`${p.population.approximate} wallets approximate, ${p.population.unsupported} unreadable`] }),
      };
    },
  },
  {
    pattern: /^\/wallets\/([^/]+)$/,
    cls: 'wallet',
    cache: CACHE_WALLET,
    run: async (_q, m, d) => {
      const a = address(m[1]);
      const c = await census(d);
      const row = c.ships.find((r) => r[0] === a);
      if (!row) throw new ApiError('WALLET_NOT_IN_CENSUS', 'this wallet is not in the census: no Tydro or Nado position was seen, or it is empty', { address: a });
      const s = decodeShip(row);
      return {
        data: {
          address: a,
          risk: s.hullTemp,
          nearLiquidation: s.watch,
          primaryType: s.primary,
          types: s.tags as Tag[],
          sizeBand: s.band,
          venues: s.venues,
          nearLiquidationByVenue: s.wound,
          nearSinceBlock: s.woundedSince,
          readBlock: s.readBlock,
          note: 'As classified by the last census run. Exact figures (balances, health factor) are on the wallet page, read live — never in the API.',
        },
        meta: meta({ source: 'census.json (hourly census)', generatedAt: c.generatedAt, freshH: API.FRESH_H.census, now: d.now(), sourceBlock: s.readBlock, rulesVersion: c.rulesVersion, completeness: s.primary === 'DARK' ? 'UNAVAILABLE' : 'COMPLETE' }),
      };
    },
  },
  {
    pattern: /^\/wallets\/([^/]+)\/history$/,
    cls: 'wallet',
    cache: CACHE_WALLET,
    run: async (q, m, d) => {
      const a = address(m[1]);
      const now = d.now();
      const r = parseRange(q.query, now, 30);
      const idx = await index(d);
      if (!idx) throw new ApiError('NOT_RECORDED_YET', 'nothing recorded yet');
      const months = monthsBetween(r.from - 31 * 86_400_000, r.to, 4).filter((x) => idx.months.includes(x));
      const files = await Promise.all(months.map((x) => d.get(walletPath(x, shardOf(a)))));
      const tl = walletTimeline(files.filter(isWalletFile) as WalletFile[], a).filter((x) => x.at >= r.from && x.at <= r.to);
      const pg = page([...tl].reverse(), q.query);
      return {
        data: pg.items,
        extra: { page: pg.page, recordingSince: idx.firstAt, range: { from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString() } },
        meta: meta({ source: 'history/w (Flight Recorder, the wallet’s own shard)', generatedAt: tl.at(-1) ? new Date(tl.at(-1)!.at).toISOString() : null, freshH: null, now, completenessNotes: ['only changes are recorded; nothing before recording began'] }),
      };
    },
  },
  {
    pattern: /^\/wallets\/([^/]+)\/scenario$/,
    cls: 'live',
    cache: 'no-store',
    run: async (q, m, d) => {
      const a = address(m[1]);
      if (d.fixtures?.has(a)) throw new ApiError('FIXTURE_REJECTED', 'test wallets have no on-chain state');
      if (!d.readWallet) throw new ApiError('NOT_ENABLED', 'live wallet reads are not available in this deployment');
      const dir = DIRECTIONS.find((x) => x.id === (q.query.dir ?? 'CRYPTO'));
      if (!dir) throw new ApiError('INVALID_PARAMETER', `dir must be one of ${DIRECTIONS.map((x) => x.id).join(', ')}`);
      const sign = (q.query.sign ?? 'down') as 'down' | 'up';
      if ((sign !== 'down' && sign !== 'up') || (sign === 'up' && dir.downOnly)) throw new ApiError('INVALID_PARAMETER', 'sign must be down (or up where the direction allows it)');
      const pct = Number(q.query.pct ?? 10);
      if (!Number.isInteger(pct) || pct < 1 || pct > 50) throw new ApiError('INVALID_PARAMETER', 'pct must be an integer 1–50');
      const book = await d.readWallet(a).catch(() => null);
      if (!book) throw new ApiError('UPSTREAM_UNAVAILABLE', 'the chain could not be read just now');
      const pose = classify(book);
      const conf = confidenceOf(book);
      const t = canBeLiquidated(book) ? thresholds(book, (p) => directionScenario(dir, sign === 'down' ? -p : p), pct) : { WATCH: null, NEAR: null, LIQ: null };
      const reached = t.LIQ !== null ? 'LIQUIDATABLE' : t.NEAR !== null ? 'NEAR' : t.WATCH !== null ? 'WATCH' : 'SAFE';
      return {
        data: {
          address: a,
          scenario: { dir: dir.id, sign, pct },
          now: pose.hullTemp,
          underScenario: reached,
          canBeLiquidated: canBeLiquidated(book),
          note: 'The level this wallet would reach under the move — not the move that liquidates it, and no balances. A simulation, not a prediction.',
        },
        meta: meta({ source: 'live read (Ink RPC)', generatedAt: new Date(d.now()).toISOString(), freshH: 1, now: d.now(), approximate: conf.confidence !== 'MODELLED', completeness: conf.confidence === 'UNSUPPORTED' ? 'PARTIAL' : 'COMPLETE', completenessNotes: conf.why }),
      };
    },
  },
  {
    pattern: /^\/oracles$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (_q, _m, d) => {
      const w = (await d.get(ORACLE_LATEST)) as OracleWatch | null;
      if (!w || w.kind !== 'aegis-oracle-watch') throw new ApiError('NOT_RECORDED_YET', 'Oracle Watch has not recorded yet');
      const { state: _s, events: _e, ...rest } = w;
      void _s;
      void _e;
      return { data: rest, meta: meta({ source: 'history/oracle/latest.json (Oracle Watch)', generatedAt: new Date(w.at).toISOString(), freshH: API.FRESH_H.oracle, now: d.now(), sourceBlock: w.block, dataVersion: w.version, completeness: w.errors.length ? 'PARTIAL' : 'COMPLETE', completenessNotes: w.errors }) };
    },
  },
  {
    pattern: /^\/oracles\/events$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (q, _m, d) => {
      const w = (await d.get(ORACLE_LATEST)) as OracleWatch | null;
      if (!w || w.kind !== 'aegis-oracle-watch') throw new ApiError('NOT_RECORDED_YET', 'Oracle Watch has not recorded yet');
      const pg = page(w.events, q.query);
      return { data: pg.items, extra: { page: pg.page }, meta: meta({ source: 'history/oracle/latest.json → events', generatedAt: new Date(w.at).toISOString(), freshH: API.FRESH_H.oracle, now: d.now(), sourceBlock: w.block, dataVersion: w.version }) };
    },
  },
  {
    pattern: /^\/changes$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (q, _m, d) => {
      const now = d.now();
      const r = parseRange(q.query, now, 30);
      const idx = await index(d);
      const recs = (await changes(d, idx, r.from, r.to)).sort((a, b) => b.between.toBlock - a.between.toBlock);
      const pg = page(recs, q.query);
      const params = (await d.get('history/params/latest.json')) as { at?: number; block?: number; since?: string } | null;
      return {
        data: pg.items,
        extra: { page: pg.page, monitoringSince: params?.since ?? null },
        meta: meta({ source: 'history/changes (Protocol Change Monitor)', generatedAt: params?.at ? new Date(params.at).toISOString() : null, freshH: API.FRESH_H.params, now, sourceBlock: params?.block ?? null, dataVersion: 'changes-1.0.0', completenessNotes: ['changes before monitoring began are not known'] }),
      };
    },
  },
  {
    pattern: /^\/liquidations$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (q, _m, d) => {
      const now = d.now();
      const r = parseRange(q.query, now, 7);
      const idx = await index(d);
      const recs = (await ledger(d, idx, r.from, r.to)).sort((a, b) => b.at - a.at || b.block - a.block);
      const pg = page(recs, q.query);
      return {
        data: pg.items,
        extra: { page: pg.page, order: 'time, newest first — a historical record, never ranked by anything else', backfill: idx?.ledger ?? null },
        meta: meta({ source: 'history/liq (Liquidation Ledger, from on-chain events)', generatedAt: recs[0] ? new Date(recs[0].at).toISOString() : null, freshH: null, now, dataVersion: 'ledger-1.0.0', completeness: recs.some((x) => x.completeness === 'PARTIAL') ? 'PARTIAL' : 'COMPLETE', completenessNotes: ['size is a range; liquidations before the backfill reached them are not listed yet'] }),
      };
    },
  },
  {
    pattern: /^\/cascades$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (q, _m, d) => {
      const now = d.now();
      const r = parseRange(q.query, now, 30);
      const idx = await index(d);
      const cs = cascades(await ledger(d, idx, r.from, r.to)).sort((a, b) => b.end - a.end);
      const pg = page(cs, q.query);
      return { data: pg.items, extra: { page: pg.page }, meta: meta({ source: 'history/liq → cascade-1.0.0 grouping', generatedAt: null, freshH: null, now, dataVersion: 'cascade-1.0.0', completenessNotes: ['grouped by timing only — a cascade is not a claim about its cause'] }) };
    },
  },
  {
    pattern: /^\/performance$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (_q, _m, d) => {
      const [acc, fc] = await Promise.all([d.get(ACCOUNT_PATH), d.get(FORECAST_SCORE_PATH)]);
      if (!acc && !fc) throw new ApiError('NOT_RECORDED_YET', 'nothing scored yet');
      const a = acc as { generatedAt?: string; version?: string } | null;
      return {
        data: { warnings: acc, pressureForecasts: fc, note: 'Every rate is n of N; under 30 cases is marked too few to judge; rules versions are never pooled.' },
        meta: meta({ source: 'history/accountability.json + history/forecast-score.json', generatedAt: a?.generatedAt ?? null, freshH: API.FRESH_H.performance, now: d.now(), dataVersion: a?.version ?? null }),
      };
    },
  },
  {
    pattern: /^\/carry$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (_q, _m, d) => {
      const c = (await d.get(CARRY_LATEST)) as CarryFile | null;
      if (!c || c.kind !== 'aegis-carry') throw new ApiError('NOT_RECORDED_YET', 'carry analytics have not been recorded yet');
      const partial = c.structures.some((s) => s.completeness !== 'COMPLETE');
      return {
        data: c,
        meta: meta({ source: 'history/carry/latest.json (Yield and Carry)', generatedAt: new Date(c.at).toISOString(), freshH: API.FRESH_H.carry, now: d.now(), sourceBlock: c.block, dataVersion: c.version, approximate: true, completeness: partial ? 'PARTIAL' : 'COMPLETE', completenessNotes: partial ? ['some structures are PARTIAL — each lists what is missing (e.g. Nado trading fees are not on-chain)'] : [] }),
      };
    },
  },
  {
    pattern: /^\/verification$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (_q, _m, d) => {
      const log = (await d.get('verification-log.json')) as VerificationRecord[] | null;
      const recs = Array.isArray(log) ? log : [];
      const groups = latestChecks(recs, d.now());
      return {
        data: groups.map((g) => ({ venue: g.venue, sourceType: g.sourceType, case: g.case, display: g.display, latestAt: g.latest?.at ?? null, latestStatus: g.latest?.status ?? null, failureReason: g.latest?.failureReason ?? null, lastSuccessAt: g.lastSuccess?.at ?? null, rulesVersion: g.latest?.rulesVersion ?? null })),
        meta: meta({ source: 'verification-log.json (automatic checks)', generatedAt: recs.at(-1)?.at ?? null, freshH: API.FRESH_H.verification, now: d.now(), completeness: recs.length ? 'COMPLETE' : 'UNAVAILABLE' }),
      };
    },
  },
  {
    pattern: /^\/events$/,
    cls: 'light',
    cache: CACHE_AGG,
    run: async (q, _m, d) => {
      const now = d.now();
      const r = parseRange(q.query, now, 7, 30);
      const type = q.query.type;
      if (type && !(INK_EVENT_TYPES as readonly string[]).includes(type)) throw new ApiError('INVALID_PARAMETER', `type must be one of ${INK_EVENT_TYPES.join(', ')}`);
      const idx = await index(d);
      const [w, ch, agg, liq, log] = await Promise.all([d.get(ORACLE_LATEST), changes(d, idx, r.from, r.to), aggPoints(d, idx, r.from - 86_400_000, r.to), ledger(d, idx, r.from - 3_600_000, r.to), d.get('verification-log.json')]);
      const all = inkEvents({ oracle: (w as OracleWatch | null)?.kind === 'aegis-oracle-watch' ? (w as OracleWatch) : null, changes: ch, agg, liquidations: liq, verification: Array.isArray(log) ? (log as VerificationRecord[]) : [], since: r.from }).filter((e) => e.at <= r.to && (!type || e.type === type));
      const pg = page(all, q.query);
      return { data: pg.items, extra: { page: pg.page }, meta: meta({ source: 'events-1.0.0 (oracle, changes, stress, cascades, verification)', generatedAt: all[0] ? new Date(all[0].at).toISOString() : null, freshH: null, now, dataVersion: 'events-1.0.0' }) };
    },
  },
];

/** Nado open-interest coverage = the smaller of longs and shorts (as the census and the Pressure page compute it). */
export function oiCoverage(c: CensusSnapshot): number | null {
  const s = (c.coverage as unknown as { share?: Record<string, number | null> } | undefined)?.share;
  const l = s?.nadoOpenInterestLongs;
  const sh = s?.nadoOpenInterestShorts;
  return typeof l === 'number' && typeof sh === 'number' ? Math.min(l, sh) : null;
}

function coverageShares(c: CensusSnapshot): Record<string, number> | null {
  const s = (c.coverage as unknown as { share?: Record<string, number> } | undefined)?.share;
  return s ? Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'number')) : null;
}

/* ───────────────────────── the handler ───────────────────────── */

const respond = (status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse => ({ status, headers: { ...JSON_H, ...headers }, body });

export async function handle(req: ApiRequest, d: ApiDeps): Promise<ApiResponse> {
  const path = (req.path || '/').replace(/\/+$/, '') || '/';
  const now = d.now();
  const isWebhook = path === '/webhooks' || path.startsWith('/webhooks/');
  try {
    if (req.method === 'OPTIONS') return respond(204, null, isWebhook ? {} : CORS);
    if (path === '/openapi.json' || path === '/') {
      if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'only GET');
      return respond(200, path === '/' ? { schema: API.SCHEMA, apiVersion: API.VERSION, docs: `${API.PREFIX}/openapi.json`, disclaimer: DISCLAIMER } : openapi(), { ...CORS, 'Cache-Control': CACHE_STATIC });
    }
    if (isWebhook) {
      const lim = d.limiter.take(req.ip, 'admin', now);
      if (!lim.ok) throw new ApiError('RATE_LIMITED', 'too many requests', { retryAfterSeconds: lim.resetS });
      if ((req.body?.length ?? 0) > API.MAX_BODY_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', `request body over ${API.MAX_BODY_BYTES} bytes`);
      if (!d.webhooks) throw new ApiError('NOT_ENABLED', 'webhooks are built but not switched on in this deployment (see docs/WEBHOOKS.md)');
      const r = await d.webhooks(req, path.split('/').slice(2));
      return { ...r, headers: { ...JSON_H, 'Cache-Control': 'no-store', ...r.headers } };
    }
    const route = ROUTES.find((r) => r.pattern.test(path));
    if (!route) throw new ApiError('NOT_FOUND', `no such endpoint: ${API.PREFIX}${path} (see ${API.PREFIX}/openapi.json)`);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError('METHOD_NOT_ALLOWED', 'this API is read-only: GET only');
    const lim = d.limiter.take(req.ip, route.cls, now);
    const rl = { 'RateLimit-Limit': String(lim.limit), 'RateLimit-Remaining': String(Math.max(0, lim.remaining)), 'RateLimit-Policy': `${lim.limit};w=60` };
    if (!lim.ok) return respond(429, errorBody('RATE_LIMITED', `too many requests: ${lim.limit} per minute for this kind of endpoint`, { retryAfterSeconds: lim.resetS }), { ...CORS, ...rl, 'Retry-After': String(lim.resetS), 'Cache-Control': 'no-store' });
    const out = await route.run(req, path.match(route.pattern)!, d);
    return respond(200, { schema: API.SCHEMA, data: out.data, ...(out.extra ?? {}), meta: out.meta }, { ...CORS, ...rl, 'Cache-Control': route.cache });
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError('UPSTREAM_UNAVAILABLE', 'a source could not be read just now');
    return respond(ERRORS[err.code], errorBody(err.code, err.message, err.details), { ...(isWebhook ? {} : CORS), 'Cache-Control': 'no-store', ...(err.code === 'RATE_LIMITED' ? { 'Retry-After': String((err.details?.retryAfterSeconds as number) ?? 60) } : {}) });
  }
}

export const ROUTE_PATTERNS = ROUTES.map((r) => ({ pattern: r.pattern.source, cls: r.cls }));
export { makeShareHandler, factsFromBook, SHARE_API, type ShareDeps, type ShareResponse } from './share.js';
