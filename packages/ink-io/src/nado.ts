import { familyOf, type FundingSide, type HealthTriple, type NadoBook, type NadoPerp, type NadoSpot } from '@aegis/pose';
import { nadoSubaccount } from './address.js';
import { getJson, type FetchLike } from './http.js';
import { Err, Ok, type Result } from './result.js';

/**
 * Nado gateway + archive (indexer). Query endpoints need NO signature (docs: "Read operations
 * (queries) don't require signing"). We never call the execute endpoint. There is no signing code here.
 *
 * Default bases are same-origin proxy paths (/nado/gateway, /nado/archive) so the app works
 * whether or not Nado sends CORS headers. Vite dev proxy + vercel.json rewrite map them to
 * https://api.prod.nado.xyz/gateway/v1 and https://api.prod.nado.xyz/archive/v1.
 */
export interface NadoConfig {
  gatewayBase: string;
  archiveBase: string;
  fetch?: FetchLike;
  /**
   * 'chain' (default): read Nado from the Ink chain via FQuerier — works everywhere the Ink RPC works.
   * 'api': Nado HTTP gateway — Cloudflare only lets Nado's own frontend through (2026-09-28), kept for if that changes.
   */
  mode?: 'chain' | 'api';
  /** max subaccounts to read per address (isolated positions each live in their own subaccount) */
  maxSubaccounts?: number;
}

export const NADO_DIRECT = {
  gateway: 'https://api.prod.nado.xyz/gateway/v1',
  archive: 'https://api.prod.nado.xyz/archive/v1',
} as const;

const X18 = 1e18;
export const x18 = (s: string | number | undefined | null): number => {
  if (s === undefined || s === null) return NaN;
  try {
    return Number(BigInt(String(s))) / X18;
  } catch {
    return NaN;
  }
};

/* ─────────────── symbols (product_id → symbol), cached ─────────────── */

export type SymbolMap = ReadonlyMap<number, { symbol: string; type: 'spot' | 'perp' }>;
let symbolCache: { at: number; map: SymbolMap } | null = null;
const SYMBOL_TTL_MS = 10 * 60 * 1000;

/** product 0 is the quote asset and is not listed by `symbols`. Docs /v2/assets example: product 0 = USDT0. */
const QUOTE_PRODUCT = { id: 0, symbol: 'USDT0' } as const;

export function parseSymbols(json: unknown): Result<SymbolMap> {
  const data = (json as { status?: string; data?: { symbols?: unknown } })?.data?.symbols;
  if (!data || typeof data !== 'object') return Err('PARSE_FAIL', 'symbols: missing data.symbols');
  const rows = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>);
  const map = new Map<number, { symbol: string; type: 'spot' | 'perp' }>();
  map.set(QUOTE_PRODUCT.id, { symbol: QUOTE_PRODUCT.symbol, type: 'spot' });
  for (const r of rows as Array<{ product_id?: number; symbol?: string; type?: string }>) {
    if (typeof r.product_id === 'number' && typeof r.symbol === 'string' && (r.type === 'spot' || r.type === 'perp')) {
      map.set(r.product_id, { symbol: r.symbol, type: r.type });
    }
  }
  if (map.size < 2) return Err('PARSE_FAIL', 'symbols: empty product list');
  return Ok(map);
}

export async function fetchSymbols(cfg: NadoConfig): Promise<Result<SymbolMap>> {
  if (symbolCache && Date.now() - symbolCache.at < SYMBOL_TTL_MS) return Ok(symbolCache.map);
  const r = await getJson(`${cfg.gatewayBase}/query?type=symbols`, undefined, { fetch: cfg.fetch });
  if (!r.ok) return r;
  const p = parseSymbols(r.value);
  if (p.ok) symbolCache = { at: Date.now(), map: p.value };
  return p;
}

/* ─────────────── subaccount discovery (archive) ─────────────── */

export interface SubaccountRef {
  subaccount: `0x${string}`;
  name: string;
  isolated: boolean;
}

/**
 * Archive `subaccounts` by address. Request shape `{ subaccounts: { address } }` is GUESSED from
 * the docs' description (see LOOKUPS.md §B.4). On any failure we fall back to the `default`
 * subaccount and say so on the plate — isolated positions would then be invisible.
 */
export async function discoverSubaccounts(address: string, cfg: NadoConfig): Promise<{ refs: SubaccountRef[]; note: string | null }> {
  const fallback = { refs: [{ subaccount: nadoSubaccount(address), name: 'default', isolated: false }] };
  const r = await getJson(
    `${cfg.archiveBase}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subaccounts: { address: address.toLowerCase() } }) },
    { fetch: cfg.fetch },
  );
  if (!r.ok) return { ...fallback, note: `Subaccount discovery unavailable (${r.error.code}) — read 'default' only; isolated positions not shown` };
  const list = (r.value as { subaccounts?: Array<{ subaccount?: string; subaccount_name?: string; isolated?: boolean }> })?.subaccounts;
  if (!Array.isArray(list)) return { ...fallback, note: `Subaccount discovery returned an unexpected shape — read 'default' only` };
  const refs: SubaccountRef[] = list
    .filter((s) => typeof s.subaccount === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s.subaccount))
    .map((s) => ({ subaccount: s.subaccount!.toLowerCase() as `0x${string}`, name: s.subaccount_name ?? '?', isolated: s.isolated === true }));
  if (refs.length === 0) return { ...fallback, note: null };
  return { refs, note: null };
}

/* ─────────────── subaccount_info parse (pure; tested against the docs payload) ─────────────── */

interface RawHealth { assets: string; liabilities: string; health: string }
interface RawProduct { product_id: number; oracle_price_x18: string }
interface RawInfo {
  subaccount: string;
  exists: boolean;
  healths: RawHealth[];
  spot_balances: Array<{ product_id: number; balance: { amount: string } }>;
  perp_balances: Array<{ product_id: number; balance: { amount: string; v_quote_balance: string } }>;
  spot_products: RawProduct[];
  perp_products: RawProduct[];
}

export interface ParsedSub {
  subaccount: string;
  exists: boolean;
  spots: NadoSpot[];
  perps: NadoPerp[];
  initial: HealthTriple | null;
  maintenance: HealthTriple | null;
  unweighted: HealthTriple | null;
}

const triple = (h: RawHealth | undefined): HealthTriple | null =>
  h ? { assetsUsd: x18(h.assets), liabilitiesUsd: x18(h.liabilities), healthUsd: x18(h.health) } : null;

export function parseSubaccountInfo(json: unknown, symbols: SymbolMap, priceSource: 'NADO_ORACLE' | 'NADO_ONCHAIN' = 'NADO_ORACLE'): Result<ParsedSub> {
  const env = json as { status?: string; data?: RawInfo; error?: string };
  if (env?.status !== 'success' || !env.data) return Err('PARSE_FAIL', `subaccount_info: ${env?.error ?? 'status ≠ success'}`);
  const d = env.data;
  if (!Array.isArray(d.spot_balances) || !Array.isArray(d.perp_balances) || !Array.isArray(d.healths)) {
    return Err('PARSE_FAIL', 'subaccount_info: missing balances/healths arrays');
  }
  const priceOf = new Map<number, number>();
  for (const p of [...(d.spot_products ?? []), ...(d.perp_products ?? [])]) priceOf.set(p.product_id, x18(p.oracle_price_x18));

  const spots: NadoSpot[] = [];
  for (const b of d.spot_balances) {
    const amount = x18(b.balance?.amount);
    if (!Number.isFinite(amount)) return Err('PARSE_FAIL', `spot ${b.product_id}: bad amount`);
    if (amount === 0) continue;
    const price = priceOf.get(b.product_id);
    if (price === undefined || !Number.isFinite(price)) return Err('PARSE_FAIL', `spot ${b.product_id}: no oracle price in response`);
    const symbol = symbols.get(b.product_id)?.symbol ?? `SPOT#${b.product_id}`;
    const { family, assetClass } = familyOf(symbol);
    spots.push({ productId: b.product_id, subaccount: d.subaccount, symbol, family, assetClass, amount, usd: amount * price, priceUsd: price, priceSource });
  }

  const perps: NadoPerp[] = [];
  for (const b of d.perp_balances) {
    const size = x18(b.balance?.amount);
    const vq = x18(b.balance?.v_quote_balance);
    if (!Number.isFinite(size) || !Number.isFinite(vq)) return Err('PARSE_FAIL', `perp ${b.product_id}: bad amount`);
    if (size === 0 && vq === 0) continue;
    const price = priceOf.get(b.product_id);
    if (price === undefined || !Number.isFinite(price)) return Err('PARSE_FAIL', `perp ${b.product_id}: no oracle price in response`);
    const symbol = symbols.get(b.product_id)?.symbol ?? `PERP#${b.product_id}`;
    const { family, assetClass } = familyOf(symbol);
    perps.push({
      productId: b.product_id, subaccount: d.subaccount, symbol, family, assetClass,
      sizeBase: size, notionalUsd: size * price, priceUsd: price, priceSource,
      vQuoteUsd: vq, unsettledUsd: vq + size * price,
    });
  }

  // healths[] order per Vertex/Nado engine HealthType enum: INITIAL=0, MAINTENANCE=1, PNL=2 (GUESSED — see LOOKUPS.md)
  return Ok({
    subaccount: d.subaccount,
    exists: d.exists !== false,
    spots,
    perps,
    initial: triple(d.healths[0]),
    maintenance: triple(d.healths[1]),
    unweighted: triple(d.healths[2]),
  });
}

/* ─────────────── aggregate across subaccounts ─────────────── */

export function aggregate(subs: ParsedSub[], notes: string[]): NadoBook {
  const live = subs.filter((s) => s.exists);
  const spots = live.flatMap((s) => s.spots);
  const perps = live.flatMap((s) => s.perps);
  const equityUsd = spots.reduce((a, s) => a + s.usd, 0) + perps.reduce((a, p) => a + p.unsettledUsd, 0);

  // Worst-buffer subaccount drives WOUNDED (an isolated position can die while the unified pool is fine).
  let maintenance: HealthTriple | null = null;
  let worst = Infinity;
  for (const s of live) {
    const m = s.maintenance;
    if (!m) continue;
    if (m.assetsUsd === 0 && m.healthUsd === 0) continue;
    const b = m.assetsUsd > 0 ? m.healthUsd / m.assetsUsd : m.healthUsd < 0 ? -1 : Infinity;
    if (b < worst) {
      worst = b;
      maintenance = m;
    }
  }
  const sumT = (pick: (s: ParsedSub) => HealthTriple | null): HealthTriple | null => {
    const ts = live.map(pick).filter((t): t is HealthTriple => t !== null);
    if (!ts.length) return null;
    return ts.reduce((a, t) => ({ assetsUsd: a.assetsUsd + t.assetsUsd, liabilitiesUsd: a.liabilitiesUsd + t.liabilitiesUsd, healthUsd: a.healthUsd + t.healthUsd }));
  };
  const unweighted = sumT((s) => s.unweighted);
  if (live.length > 1 && maintenance) notes.push(`Maintenance buffer shown is the WORST of ${live.length} subaccounts`);
  if (unweighted && (spots.length || perps.length)) {
    const diff = Math.abs(unweighted.healthUsd - equityUsd);
    if (diff > Math.max(1, Math.abs(equityUsd) * 0.01)) {
      notes.push(`healths[2] ${unweighted.healthUsd.toFixed(2)} ≠ computed equity ${equityUsd.toFixed(2)} — health index mapping may be wrong; treat buffer with caution`);
    } else {
      notes.push('healths[2] cross-check OK (matches computed equity within 1%)');
    }
  }
  const funding: FundingSide[] = perps
    .filter((p) => p.sizeBase !== 0)
    .map((p) => ({ symbol: p.symbol, side: p.sizeBase > 0 ? 'LONG' : 'SHORT', rateHourly: null }));

  return {
    subaccounts: live.map((s) => s.subaccount),
    equityUsd,
    spots,
    perps,
    maintenance,
    initial: sumT((s) => s.initial),
    unweighted,
    funding,
    notes,
  };
}

/* ─────────────── entry point ─────────────── */

export async function readNado(address: string, cfg: NadoConfig): Promise<Result<NadoBook>> {
  const sym = await fetchSymbols(cfg);
  if (!sym.ok) return sym;

  const notes: string[] = [];
  const { refs, note } = await discoverSubaccounts(address, cfg);
  if (note) notes.push(note);
  const max = cfg.maxSubaccounts ?? 8;
  if (refs.length > max) notes.push(`${refs.length} subaccounts found; reading first ${max}`);

  const subs: ParsedSub[] = [];
  for (const ref of refs.slice(0, max)) {
    const r = await getJson(`${cfg.gatewayBase}/query?type=subaccount_info&subaccount=${ref.subaccount}`, undefined, { fetch: cfg.fetch });
    if (!r.ok) return r;
    const p = parseSubaccountInfo(r.value, sym.value);
    if (!p.ok) return p;
    subs.push(p.value);
  }
  return Ok(aggregate(subs, notes));
}
