/**
 * ORACLE WATCH (pure; no IO) — `oracle-1.0.0`. Release 3.
 *
 * Every feed is an observation, not the truth. AEGIS compares:
 *   - Tydro's protocol price (AaveOracle) with the source contract behind it (staleness, decimals, mismatch)
 *   - Tydro and Nado on the SAME token — joined by contract address (Nado spot config.token == Tydro underlying),
 *     never by ticker
 *   - an external reference (Pyth) where a feed for that exact asset (or the asset it wraps 1:1) is configured —
 *     only when that reference is itself fresh
 *   - stablecoin prices against $1, per venue
 * Impact of a divergence is modelled with the Pressure engine as a whole-family move — labelled approximate,
 * never claimed as what the protocol oracle will do.
 */
import type { OracleSnapshot } from '@aegis/ink-io';
import { queryPressure, type PressureSnapshot } from './pressure.js';

export const ORACLE = {
  VERSION: 'oracle-1.0.0',
  /** a source not updated for this long is STALE (most on-chain feeds have a ≤ 24 h heartbeat) */
  STALE_H: 26,
  /** an external pull-oracle reference older than this isn't compared at all */
  REF_FRESH_H: 1,
  /** cross-source deviation */
  WARN_PCT: 0.3,
  DIVERGE_PCT: 1,
  /** stablecoin vs $1 */
  PEG_WARN_PCT: 0.5,
  PEG_BREAK_PCT: 2,
  /** move between two consecutive runs (about an hour) */
  JUMP_PCT: 5,
  /** an event for the same asset and kind is not repeated within this long */
  COOLDOWN_H: 6,
  /** a problem must be gone on this many runs in a row before "resolved" is said (no flapping) */
  RESOLVE_RUNS: 2,
  EVENTS_KEPT: 300,
} as const;

/** Assets with an external reference: the Tydro symbol → Pyth key, and how they relate. Explicit, never by ticker. */
export const REFERENCES: Record<string, { pyth: string; relation: string }> = {
  WETH: { pyth: 'ETH', relation: 'WETH is wrapped ETH, 1:1' },
  kBTC: { pyth: 'BTC', relation: 'kBTC is a 1:1 claim on BTC (wrapped — the wrapper itself can lose its peg)' },
  SolvBTC: { pyth: 'BTC', relation: 'SolvBTC is a 1:1 claim on BTC (wrapped — the wrapper itself can lose its peg)' },
  USDC: { pyth: 'USDC', relation: 'same asset' },
};

/** Stablecoins checked against $1 (yield-bearing ones such as sUSDe and syrupUSDT are not $1 by design and are left out). */
export const PEGGED = new Set(['USDT', 'USDC', 'USDG', 'GHO', 'USDe']);

/** Asset → Pressure direction used to model a divergence's impact. */
const DIRECTION: Record<string, string> = { WETH: 'ETH', kBTC: 'BTC', SolvBTC: 'BTC', USDC: 'USDC', USDe: 'USDE', USDT: 'USD', USDG: 'USD', GHO: 'USD' };

export type OracleStatus = 'OK' | 'WARN' | 'STALE' | 'DIVERGENT' | 'DEPEG' | 'JUMP' | 'INVALID' | 'UNAVAILABLE';
const SEVERITY: Record<OracleStatus, number> = { OK: 0, UNAVAILABLE: 1, WARN: 2, JUMP: 3, STALE: 3, DIVERGENT: 4, DEPEG: 4, INVALID: 5 };

export interface Check {
  kind: 'source-age' | 'source-decimals' | 'source-cap' | 'protocol-vs-source' | 'cross-venue' | 'external' | 'peg' | 'jump' | 'validity';
  status: OracleStatus;
  text: string;
  /** signed % where it applies */
  pct: number | null;
}

export interface AssetRow {
  /** canonical id: the token contract address */
  asset: string;
  symbol: string;
  usedBy: Array<'tydro' | 'nado'>;
  tydro: { price: number | null; source: string | null; sourceDescription: string | null; sourceDecimals: number | null; sourceAnswer: number | null; sourceUpdatedAt: number | null; sourceKind?: string | null; via?: Array<{ role: string; address: string; description: string | null; updatedAt: number | null }>; capped?: boolean | null } | null;
  nado: { productId: number; price: number | null } | null;
  /** Nado perp on the same underlying — basis vs spot, information only (not an oracle error) */
  perp: { productId: number; symbol: string; price: number | null } | null;
  external: { source: 'Pyth'; key: string; relation: string; price: number | null; conf: number | null; publishTime: number | null; note: string | null } | null;
  checks: Check[];
  status: OracleStatus;
  impact: Impact | null;
}

export interface Impact {
  /** the modelled move: the protocol price converging on the other source */
  direction: string;
  sign: 'up' | 'down';
  pct: number;
  basis: string;
  exact: false;
  byFloor: Record<'0' | '1k', { newlyNear: number; newlyLiquidatable: number; population: number }>;
  pressureBlock: number;
  note: string;
}

export interface OracleWatch {
  v: 1;
  kind: 'aegis-oracle-watch';
  version: string;
  block: number;
  at: number;
  rows: AssetRow[];
  /** Nado products with no Tydro counterpart: price only (used by Nado margin) */
  nadoOther: Array<{ productId: number; symbol: string | null; type: 'spot' | 'perp'; price: number | null }>;
  sources: Array<{ name: string; detail: string }>;
  errors: string[];
  summary: Record<OracleStatus, number>;
  /** per (asset, check kind): current status and bookkeeping for transitions */
  state: Record<string, { status: OracleStatus; since: number; okRuns: number; lastEventAt: number | null; lastEventStatus?: OracleStatus }>;
  events: OracleEvent[];
}

export interface OracleEvent {
  id: string;
  at: number;
  block: number;
  asset: string;
  symbol: string;
  kind: Check['kind'];
  status: OracleStatus | 'RESOLVED';
  text: string;
}

const pctDiff = (a: number, b: number) => ((a - b) / b) * 100;
const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(2) : Math.abs(x) >= 1 ? x.toFixed(4) : x.toPrecision(5));

/** Build the watch from one snapshot (+ the previous run's prices for jumps, + a Pressure snapshot for impact). */
export function buildOracleWatch(o: { snap: OracleSnapshot; prev?: OracleWatch | null; pressure?: PressureSnapshot | null; nowMs?: number }): OracleWatch {
  const { snap } = o;
  const now = o.nowMs ?? snap.at;
  const prevRows = new Map((o.prev?.rows ?? []).map((r) => [r.asset, r]));
  const nadoByToken = new Map(snap.nado.filter((n) => n.type === 'spot' && n.token).map((n) => [n.token!, n]));
  const perpBySymbol = new Map(snap.nado.filter((n) => n.type === 'perp').map((n) => [n.symbol ?? '', n]));
  const PERP_OF: Record<string, string> = { WETH: 'ETH-PERP', kBTC: 'BTC-PERP', SolvBTC: 'BTC-PERP' };
  const used = new Set<number>();

  const rows: AssetRow[] = snap.tydro.map((t) => {
    const checks: Check[] = [];
    const n = nadoByToken.get(t.asset) ?? null;
    if (n) used.add(n.productId);
    const perpRaw = PERP_OF[t.symbol] ? perpBySymbol.get(PERP_OF[t.symbol]!) : undefined;
    const ref = REFERENCES[t.symbol];
    const py = ref ? snap.pyth.find((p) => p.key === ref.pyth) : undefined;

    // validity
    if (t.priceUsd === null) checks.push({ kind: 'validity', status: 'INVALID', text: "Tydro's protocol price couldn't be read", pct: null });
    else if (!(t.priceUsd > 0) || !Number.isFinite(t.priceUsd)) checks.push({ kind: 'validity', status: 'INVALID', text: `Tydro's protocol price is not a positive number (${t.priceUsd})`, pct: null });
    // the source behind Tydro's price (a feed, or an adapter over feeds)
    const src = t.source ? { ...t.source, kind: t.source.kind ?? (t.source.updatedAt !== null ? 'chainlink' : t.source.answer !== null ? 'answer-only' : 'none') } : null;
    const viaText = src?.via?.length ? ` over ${src.via.map((v) => v.description ?? `${v.address.slice(0, 10)}…`).join(' + ')}` : '';
    if (!src) checks.push({ kind: 'source-age', status: 'UNAVAILABLE', text: "Tydro's source for this asset couldn't be read", pct: null });
    else if (src.kind === 'none') checks.push({ kind: 'source-age', status: 'UNAVAILABLE', text: `source ${src.address.slice(0, 10)}… answers no price AEGIS can read`, pct: null });
    else if (src.updatedAt === null)
      checks.push({
        kind: 'source-age',
        status: 'UNAVAILABLE',
        text:
          src.kind === 'adapter'
            ? `source is an adapter${viaText}; a feed underneath doesn't expose its update time`
            : `source ${src.address.slice(0, 10)}… answers a price but exposes no update time and no feed AEGIS recognises`,
        pct: null,
      });
    else {
      const ageH = (now - src.updatedAt) / 3_600_000;
      const what = src.kind === 'adapter' ? `adapter${viaText}: oldest feed underneath` : 'source';
      checks.push(ageH > ORACLE.STALE_H ? { kind: 'source-age', status: 'STALE', text: `${what} last updated ${ageH.toFixed(1)} h ago (over ${ORACLE.STALE_H} h)`, pct: null } : { kind: 'source-age', status: 'OK', text: `${what} updated ${ageH.toFixed(1)} h ago`, pct: null });
    }
    if (src && src.decimals !== null && src.decimals !== 8) checks.push({ kind: 'source-decimals', status: 'WARN', text: `source reports ${src.decimals} decimals (USD feeds normally use 8; an adapter may rescale)`, pct: null });
    if (src?.capped) checks.push({ kind: 'source-cap', status: 'WARN', text: "the adapter's price cap is active: Tydro values this asset at the cap, below what its feed says", pct: null });
    if (t.priceUsd && src?.answer && src.decimals === 8) {
      const d = pctDiff(t.priceUsd, src.answer);
      if (Math.abs(d) > 0.01) checks.push({ kind: 'protocol-vs-source', status: Math.abs(d) >= ORACLE.DIVERGE_PCT ? 'DIVERGENT' : 'WARN', text: `Tydro's price differs from its own source by ${d.toFixed(2)}% (something sits between them)`, pct: d });
    }
    // cross-venue on the same token
    if (t.priceUsd && n?.priceUsd) {
      const d = pctDiff(t.priceUsd, n.priceUsd);
      const st: OracleStatus = Math.abs(d) >= ORACLE.DIVERGE_PCT ? 'DIVERGENT' : Math.abs(d) >= ORACLE.WARN_PCT ? 'WARN' : 'OK';
      checks.push({ kind: 'cross-venue', status: st, text: `Tydro vs Nado on the same token: ${d >= 0 ? '+' : ''}${d.toFixed(2)}%`, pct: d });
    }
    // external reference, only when it is itself fresh
    let external: AssetRow['external'] = null;
    if (ref) {
      const fresh = py?.publishTime ? (now - py.publishTime) / 3_600_000 <= ORACLE.REF_FRESH_H : false;
      const note = !py || py.error ? `Pyth unreadable${py?.error ? `: ${py.error}` : ''}` : !fresh ? `Pyth last published ${py.publishTime ? `${((now - py.publishTime) / 3_600_000).toFixed(1)} h` : '?'} ago — a pull oracle, updated only when someone pushes; not compared` : null;
      external = { source: 'Pyth', key: ref.pyth, relation: ref.relation, price: py?.price ?? null, conf: py?.conf ?? null, publishTime: py?.publishTime ?? null, note };
      if (fresh && py?.price && t.priceUsd) {
        const d = pctDiff(t.priceUsd, py.price);
        const st: OracleStatus = Math.abs(d) >= ORACLE.DIVERGE_PCT ? 'DIVERGENT' : Math.abs(d) >= ORACLE.WARN_PCT ? 'WARN' : 'OK';
        const within = py.conf ? Math.abs(t.priceUsd - py.price) <= py.conf : false;
        checks.push({ kind: 'external', status: within ? 'OK' : st, text: `vs Pyth ${ref.pyth}/USD: ${d >= 0 ? '+' : ''}${d.toFixed(2)}%${py.conf ? ` (Pyth ±${fmt(py.conf)}${within ? ', inside its confidence band' : ''})` : ''}`, pct: d });
      } else if (note) checks.push({ kind: 'external', status: 'UNAVAILABLE', text: note, pct: null });
    }
    // stablecoin peg, per venue
    if (PEGGED.has(t.symbol)) {
      for (const [venue, p] of [
        ['Tydro', t.priceUsd],
        ['Nado', n?.priceUsd ?? null],
      ] as const) {
        if (p === null || p === undefined) continue;
        if (venue === 'Nado' && n && n.productId === 0) continue; // Nado's quote (USDT0) is its unit of account: $1 by definition
        const d = (p - 1) * 100;
        const st: OracleStatus = Math.abs(d) >= ORACLE.PEG_BREAK_PCT ? 'DEPEG' : Math.abs(d) >= ORACLE.PEG_WARN_PCT ? 'WARN' : 'OK';
        checks.push({ kind: 'peg', status: st, text: `${venue}: $${p.toFixed(4)} (${d >= 0 ? '+' : ''}${d.toFixed(2)}% from $1)`, pct: d });
      }
    }
    // sudden jump since the previous run
    const before = prevRows.get(t.asset)?.tydro?.price ?? null;
    if (before && t.priceUsd) {
      const d = pctDiff(t.priceUsd, before);
      if (Math.abs(d) >= ORACLE.JUMP_PCT) checks.push({ kind: 'jump', status: 'JUMP', text: `Tydro price moved ${d >= 0 ? '+' : ''}${d.toFixed(1)}% since the previous run`, pct: d });
    }
    const status = checks.reduce<OracleStatus>((m, c) => (SEVERITY[c.status] > SEVERITY[m] ? c.status : m), 'OK');
    const usedBy: AssetRow['usedBy'] = ['tydro', ...(n ? (['nado'] as const) : [])];
    const row: AssetRow = {
      asset: t.asset,
      symbol: t.symbol === 'USDT' ? 'USDT0' : t.symbol,
      usedBy,
      tydro: { price: t.priceUsd, source: t.source?.address ?? null, sourceDescription: t.source?.description ?? null, sourceDecimals: t.source?.decimals ?? null, sourceAnswer: t.source?.answer ?? null, sourceUpdatedAt: t.source?.updatedAt ?? null, sourceKind: t.source?.kind ?? null, via: (t.source?.via ?? []).map((v) => ({ role: v.role, address: v.address, description: v.description, updatedAt: v.updatedAt })), capped: t.source?.capped ?? null },
      nado: n ? { productId: n.productId, price: n.priceUsd } : null,
      perp: perpRaw ? { productId: perpRaw.productId, symbol: perpRaw.symbol ?? '', price: perpRaw.priceUsd } : null,
      external,
      checks,
      status,
      impact: null,
    };
    row.impact = o.pressure ? impactOf(row, o.pressure) : null;
    return row;
  });

  const summary = Object.fromEntries((Object.keys(SEVERITY) as OracleStatus[]).map((k) => [k, rows.filter((r) => r.status === k).length])) as Record<OracleStatus, number>;
  const watch: OracleWatch = {
    v: 1,
    kind: 'aegis-oracle-watch',
    version: ORACLE.VERSION,
    block: snap.block,
    at: snap.at,
    rows,
    nadoOther: snap.nado.filter((n) => !used.has(n.productId)).map((n) => ({ productId: n.productId, symbol: n.symbol, type: n.type, price: n.priceUsd })),
    sources: [
      { name: 'Tydro AaveOracle', detail: 'protocol prices Tydro uses; per-asset source from getSourceOfAsset, read through the Chainlink interface' },
      { name: 'Nado (FQuerier)', detail: "oracle prices Nado's margin uses; update time not exposed on-chain" },
      { name: 'Pyth (external reference)', detail: 'ETH, BTC, USDC on Ink — a pull oracle, compared only when fresh' },
    ],
    errors: snap.errors,
    summary,
    state: {},
    events: [],
  };
  return transitions(watch, o.prev ?? null);
}

/** Model a divergence as the protocol price converging on the other source, with the Pressure engine. */
export function impactOf(row: AssetRow, ps: PressureSnapshot): Impact | null {
  const dir = DIRECTION[row.symbol === 'USDT0' ? 'USDT' : row.symbol];
  if (!dir) return null;
  const worst = row.checks.filter((c) => (c.status === 'DIVERGENT' || c.status === 'DEPEG') && c.pct !== null).sort((a, b) => Math.abs(b.pct!) - Math.abs(a.pct!))[0];
  if (!worst) return null;
  // pct is (P − Q)/Q (peg: Q = 1). Converging means P moves to Q, a move of (Q − P)/P = −pct/(100 + pct), in %.
  const move = (-worst.pct! / (100 + worst.pct!)) * 100;
  const sign: 'up' | 'down' = move < 0 ? 'down' : 'up';
  const pct = Math.max(1, Math.min(50, Math.ceil(Math.abs(move))));
  const q = (material: '0' | '1k') => {
    const r = queryPressure(ps, { dir, sign, pct, material, dim: '*' });
    return { newlyNear: r.safeToNear + r.watchToNear, newlyLiquidatable: r.newlyLiquidatable, population: r.population };
  };
  return {
    direction: dir,
    sign,
    pct,
    basis: worst.text,
    exact: false,
    byFloor: { '0': q('0'), '1k': q('1k') },
    pressureBlock: ps.block,
    note: `Modelled with the Pressure engine as a whole-${dir} move of ${sign === 'down' ? '−' : '+'}${pct}% (rounded up to a whole %, from the map built at block ${ps.block.toLocaleString('en-US')}). Approximate — not a prediction that the protocol price will move.`,
  };
}

/** Events on transitions only: entering a problem (cooldown per asset+kind), and resolving after RESOLVE_RUNS clean runs. */
function transitions(w: OracleWatch, prev: OracleWatch | null): OracleWatch {
  const state: OracleWatch['state'] = { ...(prev?.state ?? {}) };
  const events: OracleEvent[] = [];
  const now = w.at;
  const BAD = new Set<OracleStatus>(['STALE', 'DIVERGENT', 'DEPEG', 'JUMP', 'INVALID']);
  const seenKeys = new Set<string>();
  for (const r of w.rows) {
    const byKind = new Map<Check['kind'], Check>();
    for (const c of r.checks) {
      const cur = byKind.get(c.kind);
      if (!cur || SEVERITY[c.status] > SEVERITY[cur.status]) byKind.set(c.kind, c);
    }
    for (const [kind, c] of byKind) {
      const key = `${r.asset}|${kind}`;
      seenKeys.add(key);
      const s = state[key] ?? { status: 'OK' as OracleStatus, since: now, okRuns: 0, lastEventAt: null };
      const bad = BAD.has(c.status);
      const wasBad = BAD.has(s.status);
      if (bad && (!wasBad || SEVERITY[c.status] > SEVERITY[s.status])) {
        const cooled = s.lastEventAt !== null && now - s.lastEventAt < ORACLE.COOLDOWN_H * 3_600_000 && (s.lastEventStatus ?? s.status) === c.status;
        if (!cooled) {
          events.push({ id: `${key}|${c.status}|${w.block}`, at: now, block: w.block, asset: r.asset, symbol: r.symbol, kind, status: c.status, text: `${r.symbol}: ${c.text}` });
          s.lastEventAt = now;
          s.lastEventStatus = c.status;
        }
        state[key] = { status: c.status, since: now, okRuns: 0, lastEventAt: s.lastEventAt, lastEventStatus: s.lastEventStatus };
      } else if (!bad && wasBad) {
        const okRuns = s.okRuns + 1;
        if (okRuns >= ORACLE.RESOLVE_RUNS) {
          events.push({ id: `${key}|RESOLVED|${w.block}`, at: now, block: w.block, asset: r.asset, symbol: r.symbol, kind, status: 'RESOLVED', text: `${r.symbol}: ${kind} back to normal (${c.text})` });
          state[key] = { status: c.status, since: now, okRuns: 0, lastEventAt: s.lastEventAt, lastEventStatus: s.lastEventStatus };
        } else state[key] = { ...s, okRuns };
      } else if (bad) state[key] = { ...s, okRuns: 0 };
      else state[key] = { ...s, status: c.status, okRuns: 0 };
    }
  }
  // a check that disappeared (e.g. a reference no longer readable) keeps its last state; never silently cleared
  return { ...w, state, events: [...events, ...(prev?.events ?? [])].slice(0, ORACLE.EVENTS_KEPT) };
}

/* ───────────────────────── price history (for charts and forecast scoring) ───────────────────────── */

export interface PricePoint {
  block: number;
  at: number;
  /** "tydro:WETH", "nado:4", "pyth:ETH" → USD */
  p: Record<string, number>;
}

export interface PriceFile {
  v: 1;
  kind: 'aegis-prices';
  month: string;
  points: PricePoint[];
}

export const pricePath = (month: string) => `history/prices/${month}.json` as const;
export const ORACLE_LATEST = 'history/oracle/latest.json' as const;

export function pricePoint(snap: OracleSnapshot): PricePoint {
  const p: Record<string, number> = {};
  for (const t of snap.tydro) if (t.priceUsd !== null && t.priceUsd > 0) p[`tydro:${t.symbol}`] = t.priceUsd;
  for (const n of snap.nado) if (n.priceUsd !== null && n.priceUsd > 0) p[`nado:${n.productId}`] = n.priceUsd;
  for (const y of snap.pyth) if (y.price !== null && y.price > 0) p[`pyth:${y.key}`] = y.price;
  return { block: snap.block, at: snap.at, p };
}

export function appendPrices(file: unknown, month: string, pt: PricePoint): PriceFile {
  const f = file as PriceFile;
  const base: PriceFile = f && f.v === 1 && f.kind === 'aegis-prices' && f.month === month && Array.isArray(f.points) ? { ...f, points: [...f.points] } : { v: 1, kind: 'aegis-prices', month, points: [] };
  if (!base.points.some((x) => x.block === pt.block)) base.points.push(pt);
  base.points.sort((a, b) => a.block - b.block);
  return base;
}
