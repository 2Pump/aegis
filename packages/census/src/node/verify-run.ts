/**
 * AUTOMATIC VERIFICATION (`pnpm verify:auto`, run every ~4 hours by the hourly census (census.yml → "Checks (when due)"); by hand via verify.yml).
 *
 * Picks representative real wallets from the latest census (a Tydro borrower, a Nado default-only wallet, a Nado
 * wallet with an isolated subaccount), reads each with the exact readers the site uses, and compares them with
 * authoritative sources Phrourax's own path does NOT use:
 *   Tydro  AaveProtocolDataProvider.getUserReserveData (balances) + Σ(collateral × liquidation threshold) / debt
 *          recomputed from getReserveConfigurationData and the oracle, at the SAME block      → source type on-chain
 *   Nado   Clearinghouse.getHealth(subaccount, MAINTENANCE) for EVERY subaccount read (Phrourax reads FQuerier)
 *                                                                                              → source type on-chain
 *          Nado's official API (gateway subaccount_info), plain request; it sits behind a Cloudflare challenge
 *          that only Nado's own site passes, so this is expected to be SOURCE UNAVAILABLE — recorded as such,
 *          never as a pass, and never worked around.
 * Read-only: view calls and one GET. No keys that can move funds. Records are appended to verification-log.json;
 * nothing is ever deleted.
 */
import type { PublicClient } from 'viem';
import { parseAbi, type Address } from 'viem';
import {
  NADO_CONTRACTS,
  NADO_DIRECT,
  NADO_PRODUCTS,
  TYDRO,
  TYDRO_RESERVES,
  aggregate,
  nadoSubaccount,
  parseSubaccountInfo,
  readBook,
  subaccountKind,
  type NadoDiscovery,
} from '@aegis/ink-io';
import { RULES, SCENARIO_ENGINE_VERSION, type Book } from '@aegis/pose';
import { decodeSnapshot, type CensusShip } from '../index.js';
import { VERIFY, appendRecords, compareField, notChecked, finalize, shortWallet, type FieldCheck, type VerificationRecord } from '../verify.js';
import type { CensusStore } from './store.js';

const dataProviderAbi = parseAbi([
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
]);
const oracleAbi = parseAbi(['function getAssetsPrices(address[] assets) view returns (uint256[])', 'function BASE_CURRENCY_UNIT() view returns (uint256)']);
const getHealthAbi = parseAbi(['function getHealth(bytes32 subaccount, uint8 healthType) view returns (int128)']);
/**
 * E-Mode (2026-10-10): a wallet in an E-Mode category gets that category's liquidation threshold for the assets the
 * category covers — some assets (e.g. syrupUSDT) count as collateral ONLY inside E-Mode (standard threshold 0). The
 * recomputation must apply it, or it reports 0 for a healthy wallet. Two Aave v3 layouts are supported:
 *   v3.2+: getEModeCategoryCollateralConfig(id) + getEModeCategoryCollateralBitmap(id), reserve id from getReserveData
 *   v3.0/3.1: getEModeCategoryData(id) + the data provider's getReserveEModeCategory(asset)
 */
const poolEModeAbi = parseAbi([
  'function getUserEMode(address user) view returns (uint256)',
  'function getEModeCategoryCollateralConfig(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus))',
  'function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
  'function getEModeCategoryData(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, address priceSource, string label))',
]);
const dpEModeAbi = parseAbi(['function getReserveEModeCategory(address asset) view returns (uint256)']);

/** The liquidation threshold (bps) each reserve gets for this wallet under its E-Mode, or null = not in E-Mode. Throws if the wallet is in E-Mode but the category can't be read. */
export async function eModeThresholds(client: PublicClient, user: Address, blockNumber: bigint): Promise<{ category: number; layout: string; lt: Map<string, number> } | null> {
  const category = Number(await client.readContract({ address: TYDRO.POOL, abi: poolEModeAbi, functionName: 'getUserEMode', args: [user], blockNumber }));
  if (!category) return null;
  const lt = new Map<string, number>();
  try {
    const [cfg, bitmap] = await Promise.all([
      client.readContract({ address: TYDRO.POOL, abi: poolEModeAbi, functionName: 'getEModeCategoryCollateralConfig', args: [category], blockNumber }),
      client.readContract({ address: TYDRO.POOL, abi: poolEModeAbi, functionName: 'getEModeCategoryCollateralBitmap', args: [category], blockNumber }),
    ]);
    const ids = await Promise.all(TYDRO_RESERVES.map((r) => client.readContract({ address: TYDRO.POOL, abi: poolEModeAbi, functionName: 'getReserveData', args: [r.underlying], blockNumber })));
    TYDRO_RESERVES.forEach((r, i) => {
      if ((BigInt(bitmap) >> BigInt(ids[i]!.id)) & 1n) lt.set(r.underlying.toLowerCase(), Number(cfg.liquidationThreshold));
    });
    return { category, layout: 'v3.2 collateral bitmap', lt };
  } catch {
    const data = await client.readContract({ address: TYDRO.POOL, abi: poolEModeAbi, functionName: 'getEModeCategoryData', args: [category], blockNumber });
    const cats = await Promise.all(TYDRO_RESERVES.map((r) => client.readContract({ address: TYDRO.AAVE_PROTOCOL_DATA_PROVIDER, abi: dpEModeAbi, functionName: 'getReserveEModeCategory', args: [r.underlying], blockNumber })));
    TYDRO_RESERVES.forEach((r, i) => {
      if (Number(cats[i]) === category) lt.set(r.underlying.toLowerCase(), Number(data.liquidationThreshold));
    });
    return { category, layout: 'v3.0 category data', lt };
  }
}

export interface VerifyOpts {
  client: PublicClient;
  store: CensusStore;
  log?: (m: string) => void;
  /** injectable for tests; defaults to global fetch */
  fetch?: (url: string) => Promise<{ status: number; ok: boolean; headers: { get(k: string): string | null }; json(): Promise<unknown> }>;
  now?: () => number;
  /** how many candidates to try per case before giving up (bounded RPC use); default per case */
  tries?: number;
}

type Case = {
  name: string;
  venue: 'tydro' | 'nado';
  pick: (s: CensusShip) => boolean;
  /** lower = tried first: wallets the census already knows have what this case needs */
  tier?: (s: CensusShip) => number;
  tries: number;
  need: (b: Book) => boolean;
};

const CASES: Case[] = [
  {
    // most Tydro wallets only deposit; the census flags tell which ones borrow (a Tydro wound, a same-family loop,
    // an at-risk watch), so those are tried first, then everyone else
    name: 'Tydro borrower',
    venue: 'tydro',
    pick: (s) => s.venues.tydro && s.primary !== 'EMPTY',
    tier: (s) => (s.wound.tydro || s.correlatedLoop ? 0 : s.watch || s.hullTemp === 'ELEVATED' || s.hullTemp === 'CRITICAL' ? 1 : 2),
    tries: 40,
    need: (b) => b.tydro.status === 'OK' && b.tydro.data.debts.length > 0,
  },
  { name: 'Nado default subaccount', venue: 'nado', tries: 5, pick: (s) => s.venues.nado && s.extraSubs.length === 0, need: (b) => b.nado.status === 'OK' && (b.nado.data.spots.length > 0 || b.nado.data.perps.length > 0) },
  { name: 'Nado isolated subaccount', venue: 'nado', tries: 10, pick: (s) => s.venues.nado && s.extraSubs.some((x) => subaccountKind(x) === 'isolated'), need: (b) => b.nado.status === 'OK' && (b.nado.data.coverage?.subs.some((x) => x.kind === 'isolated') ?? false) },
];

/** a different wallet each day, deterministically (no randomness to argue about) */
function rotate<T extends { address: string }>(xs: T[], day: number): T[] {
  if (!xs.length) return xs;
  const k = day % xs.length;
  return [...xs.slice(k), ...xs.slice(0, k)];
}

export async function runVerification(o: VerifyOpts): Promise<VerificationRecord[]> {
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  const doFetch = o.fetch ?? ((u: string) => fetch(u, { headers: { accept: 'application/json' } }) as never);
  const raw = await o.store.get('census.json');
  if (!raw) throw new Error('no census.json yet — run the census first');
  const { snap, ships } = decodeSnapshot(raw);
  const discovery = (addr: string): Promise<NadoDiscovery | null> =>
    Promise.resolve(snap.discovery.backfillComplete ? { subs: ships.find((s) => s.address === addr.toLowerCase())?.extraSubs ?? [], throughBlock: snap.block } : null);
  // a different set of wallets every run (one slot per VERIFY.EVERY_HOURS), so over a day many wallets get checked
  const slot = Math.floor(now() / (VERIFY.EVERY_HOURS * 3_600_000));
  const records: VerificationRecord[] = [];
  const base = { v: 1 as const, kind: 'auto' as const, rulesVersion: RULES.RULES_VERSION, engineVersion: SCENARIO_ENGINE_VERSION };

  for (const c of CASES) {
    const pool = ships.filter((s) => s.primary !== 'DARK' && c.pick(s)).sort((a, b) => (a.address < b.address ? -1 : 1));
    // rotate within each tier, best tier first
    const tiers = new Map<number, CensusShip[]>();
    for (const s of pool) {
      const t = c.tier ? c.tier(s) : 0;
      tiers.set(t, [...(tiers.get(t) ?? []), s]);
    }
    const candidates = [...tiers.keys()]
      .sort((a, b) => a - b)
      .flatMap((t) => rotate(tiers.get(t)!, slot))
      .slice(0, o.tries ?? c.tries);
    let done = false;
    for (const s of candidates) {
      const { book } = await readBook(s.address as `0x${string}`, { client: o.client, nado: { mode: 'chain', gatewayBase: NADO_DIRECT.gateway, archiveBase: NADO_DIRECT.archive }, nadoDiscovery: discovery });
      if (!c.need(book)) continue;
      const at = new Date(now()).toISOString();
      if (c.venue === 'tydro') records.push(await verifyTydro(o.client, book, c.name, at, base));
      else {
        records.push(await verifyNadoChain(o.client, book, c.name, at, base));
        records.push(await verifyNadoApi(doFetch, book, c.name, at, base));
      }
      log(`verify · ${c.name} · ${shortWallet(s.address)} · ${records.slice(-(c.venue === 'tydro' ? 1 : 2)).map((r) => `${r.sourceType} ${r.status}`).join(' · ')}`);
      done = true;
      break;
    }
    if (!done) {
      // recorded as NOT CHECKED (shown on the page), never left out and never a pass
      const why = `no suitable wallet found in ${candidates.length} tries this run`;
      const at = new Date(now()).toISOString();
      const types = c.venue === 'tydro' ? (['on-chain'] as const) : (['on-chain', 'official-api'] as const);
      for (const t of types) records.push(notChecked({ ...base, venue: c.venue, wallet: '—', case: c.name, source: '—', sourceType: t, at, failureReason: why }));
      log(`verify · ${c.name} · ${why} — recorded as NOT CHECKED (nothing to check is not a pass)`);
    }
  }

  const prev = await o.store.get('verification-log.json');
  const all = appendRecords(prev, records);
  await o.store.put('verification-log.json', all);
  log(`verify · ${records.length} records written (${all.length} in the log; history is never deleted)`);
  return records;
}

type Base = Pick<VerificationRecord, 'v' | 'kind' | 'rulesVersion' | 'engineVersion'>;

async function verifyTydro(client: PublicClient, book: Book, name: string, at: string, base: Base): Promise<VerificationRecord> {
  const rec = { ...base, venue: 'tydro' as const, wallet: shortWallet(book.address), case: name, source: 'AaveProtocolDataProvider + AaveOracle (on-chain, same block)', sourceType: 'on-chain' as const, at, block: book.asOfBlock };
  if (book.tydro.status !== 'OK' || book.asOfBlock === null) return finalize({ ...rec, fields: [], sourceUnavailable: false, failureReason: "Phrourax couldn't read Tydro for this wallet" });
  const t = book.tydro.data;
  const blockNumber = BigInt(book.asOfBlock);
  try {
    const [unit, prices, userRes, cfgRes] = await Promise.all([
      client.readContract({ address: TYDRO.ORACLE, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT', blockNumber }),
      client.readContract({ address: TYDRO.ORACLE, abi: oracleAbi, functionName: 'getAssetsPrices', args: [TYDRO_RESERVES.map((r) => r.underlying)], blockNumber }),
      Promise.all(TYDRO_RESERVES.map((r) => client.readContract({ address: TYDRO.AAVE_PROTOCOL_DATA_PROVIDER, abi: dataProviderAbi, functionName: 'getUserReserveData', args: [r.underlying, book.address as Address], blockNumber }))),
      Promise.all(TYDRO_RESERVES.map((r) => client.readContract({ address: TYDRO.AAVE_PROTOCOL_DATA_PROVIDER, abi: dataProviderAbi, functionName: 'getReserveConfigurationData', args: [r.underlying], blockNumber }))),
    ]);
    // the wallet's E-Mode, if any — without it the recomputation would be wrong, so an unreadable E-Mode is "source unavailable", never a pass or a fail
    let emode: Awaited<ReturnType<typeof eModeThresholds>>;
    try {
      emode = await eModeThresholds(client, book.address as Address, blockNumber);
    } catch (e) {
      return finalize({ ...rec, source: `${rec.source} + Pool E-Mode`, fields: [], sourceUnavailable: true, failureReason: `the wallet's E-Mode configuration couldn't be read: ${String(e).slice(0, 140)}` });
    }
    const fields: FieldCheck[] = [];
    let weighted = 0;
    let debtUsd = 0;
    TYDRO_RESERVES.forEach((r, i) => {
      const sym = r.symbol === 'USDT' ? 'USDT0' : r.symbol;
      const u = userRes[i]!;
      const px = Number(prices[i]!) / Number(unit);
      const sup = Number(u[0]) / 10 ** r.decimals;
      const debt = (Number(u[1]) + Number(u[2])) / 10 ** r.decimals;
      const aSup = t.supplies.find((s) => s.symbol === sym)?.amount ?? 0;
      const aDebt = t.debts.find((s) => s.symbol === sym)?.amount ?? 0;
      if (sup > 0 || aSup > 0) fields.push(compareField({ id: `supply.${sym}`, label: `${sym} supplied`, expected: sup, aegis: aSup, tolerance: 1e-9, unit: 'rel' }));
      if (debt > 0 || aDebt > 0) fields.push(compareField({ id: `debt.${sym}`, label: `${sym} borrowed`, expected: debt, aegis: aDebt, tolerance: 1e-9, unit: 'rel' }));
      const ltBps = emode?.lt.get(r.underlying.toLowerCase()) ?? Number(cfgRes[i]![2]);
      if (u[8] && sup > 0) weighted += sup * px * (ltBps / 10_000);
      debtUsd += debt * px;
    });
    if (t.hf !== null && debtUsd > 0) fields.push(compareField({ id: 'hf', label: 'health factor', expected: weighted / debtUsd, aegis: t.hf, tolerance: 0.005, unit: 'rel' }));
    const source = emode ? `${rec.source} + Pool E-Mode category ${emode.category} (${emode.layout})` : rec.source;
    return finalize({ ...rec, source, fields, sourceUnavailable: false });
  } catch (e) {
    return finalize({ ...rec, fields: [], sourceUnavailable: true, failureReason: `on-chain source unreachable: ${String(e).slice(0, 160)}` });
  }
}

async function verifyNadoChain(client: PublicClient, book: Book, name: string, at: string, base: Base): Promise<VerificationRecord> {
  const rec = { ...base, venue: 'nado' as const, wallet: shortWallet(book.address), case: name, source: 'Nado Clearinghouse.getHealth per subaccount (on-chain; Phrourax reads FQuerier)', sourceType: 'on-chain' as const, at, block: book.asOfBlock };
  if (book.nado.status !== 'OK') return finalize({ ...rec, fields: [], sourceUnavailable: false, failureReason: "Phrourax couldn't read Nado for this wallet" });
  const n = book.nado.data;
  const subs = n.subHealth ?? [];
  try {
    const fields: FieldCheck[] = [];
    for (const x of subs) {
      if (!x.maintenance) continue;
      const v = await client.readContract({ address: NADO_CONTRACTS.clearinghouse, abi: getHealthAbi, functionName: 'getHealth', args: [x.subaccount as `0x${string}`, 1], ...(book.asOfBlock ? { blockNumber: BigInt(book.asOfBlock) } : {}) });
      fields.push(compareField({ id: `maint.${x.subaccount.slice(42)}`, label: `maintenance health, ${subaccountKind(x.subaccount)} subaccount`, expected: Number(v) / 1e18, aegis: x.maintenance.healthUsd, tolerance: 0.01, unit: 'rel' }));
    }
    const iso = n.coverage?.subs.filter((s) => s.kind === 'isolated').length ?? 0;
    fields.push(compareField({ id: 'coverage', label: 'Nado report complete', expected: 1, aegis: n.coverage?.status === 'COMPLETE' ? 1 : 0, tolerance: 0, unit: 'abs' }));
    return finalize({ ...rec, source: iso ? `${rec.source} · ${iso} isolated subaccount${iso === 1 ? '' : 's'}` : rec.source, fields, sourceUnavailable: false });
  } catch (e) {
    return finalize({ ...rec, fields: [], sourceUnavailable: true, failureReason: `on-chain source unreachable: ${String(e).slice(0, 160)}` });
  }
}

async function verifyNadoApi(doFetch: NonNullable<VerifyOpts['fetch']>, book: Book, name: string, at: string, base: Base): Promise<VerificationRecord> {
  const rec = { ...base, venue: 'nado' as const, wallet: shortWallet(book.address), case: name, source: "Nado's official API (gateway subaccount_info)", sourceType: 'official-api' as const, at, block: book.asOfBlock };
  const url = `${NADO_DIRECT.gateway}/query?type=subaccount_info&subaccount=${nadoSubaccount(book.address)}`;
  try {
    const res = await doFetch(url);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) {
      return finalize({ ...rec, fields: [], sourceUnavailable: true, failureReason: `HTTP ${res.status} — Nado's API only answers its own website (Cloudflare challenge); Phrourax does not get around that` });
    }
    const parsed = parseSubaccountInfo(await res.json(), NADO_PRODUCTS, 'NADO_ORACLE');
    if (!parsed.ok) return finalize({ ...rec, fields: [], sourceUnavailable: true, failureReason: `reply didn't parse: ${parsed.error.message}` });
    if (book.nado.status !== 'OK') return finalize({ ...rec, fields: [], sourceUnavailable: false, failureReason: "Phrourax couldn't read Nado for this wallet" });
    const api = aggregate([parsed.value], []);
    const mine = book.nado.data;
    const def = nadoSubaccount(book.address);
    const fields: FieldCheck[] = [];
    for (const sp of api.spots) fields.push(compareField({ id: `spot.${sp.symbol}`, label: `${sp.symbol} balance (default)`, expected: sp.amount, aegis: mine.spots.find((x) => x.symbol === sp.symbol && x.subaccount === def)?.amount ?? 0, tolerance: 0.001, unit: 'rel' }));
    for (const p of api.perps) fields.push(compareField({ id: `perp.${p.symbol}`, label: `${p.symbol} size (default)`, expected: p.sizeBase, aegis: mine.perps.find((x) => x.symbol === p.symbol && x.subaccount === def)?.sizeBase ?? 0, tolerance: 0.0001, unit: 'rel' }));
    return finalize({ ...rec, fields, sourceUnavailable: false });
  } catch (e) {
    return finalize({ ...rec, fields: [], sourceUnavailable: true, failureReason: `unreachable: ${String(e).slice(0, 160)}` });
  }
}
