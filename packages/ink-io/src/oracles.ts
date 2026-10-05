/**
 * ORACLE + PARAMETER READS (read-only view calls, one block). Release 3.
 *
 * Sources, and how each was established (no address is guessed):
 *  - Tydro AaveOracle (TYDRO.ORACLE, aave-address-book) — the prices Tydro's health factor uses.
 *    Its per-asset source contract comes from AaveOracle.getSourceOfAsset(asset), read on-chain; each source is
 *    then read through the Chainlink AggregatorV3 interface (latestRoundData / decimals / description). A source
 *    that doesn't answer that interface is reported as such — its update time is then unknown, never assumed.
 *  - Nado oracle prices — FQuerier.getSubaccountInfo returns every product with its oracle price (what Nado's
 *    margin uses). Nado doesn't expose a per-product update time on-chain: its age is "not exposed".
 *  - Pyth (external reference) — contract 0x2880aB155794e7179c9eE2e38200202908C17B43 per Pyth's own EVM
 *    contract list (Ink row); feed ids ETH/USD, BTC/USD, USDC/USD per Pyth's documentation. Pyth on EVM is a
 *    PULL oracle: the on-chain price moves only when someone pushes an update, so a stale Pyth value is normal
 *    and is reported as stale — it is never treated as the truth.
 * Every call is allowed to fail; a failure is recorded, never filled in.
 */
import type { PublicClient } from 'viem';
import { multicallAdaptive, type Call } from './batch.js';
import { nadoSubaccount } from './address.js';
import { NADO_CONTRACTS, NADO_PRODUCTS, QUERIER_GET_SUBACCOUNT_INFO_ABI } from './nado-registry.js';
import { Err, Ok, errMessage, type Result } from './result.js';
import { TYDRO, TYDRO_RESERVES } from './tydro-registry.js';

export const PYTH = {
  address: '0x2880aB155794e7179c9eE2e38200202908C17B43' as const,
  addressSource: 'docs.pyth.network/price-feeds/contract-addresses/evm — Ink row (checked 2026-10-04)',
  idsSource: 'docs.pyth.network push-integration (ETH/USD); docs.hiro.so Pyth guide (BTC/USD, ETH/USD, USDC/USD) — checked 2026-10-04',
  feeds: {
    ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    USDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  } as Record<string, `0x${string}`>,
};

const aaveOracleAbi = [
  { type: 'function', name: 'BASE_CURRENCY_UNIT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getAssetsPrices', stateMutability: 'view', inputs: [{ type: 'address[]' }], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'getSourceOfAsset', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getFallbackOracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
const aggregatorAbi = [
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
  { type: 'function', name: 'latestAnswer', stateMutability: 'view', inputs: [], outputs: [{ type: 'int256' }] },
  { type: 'function', name: 'latestTimestamp', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'isCapped', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;
/**
 * Getters of Aave's price adapters that point at the feed(s) underneath. Each is tried on every source; a
 * contract that doesn't have it simply fails that call. Names from aave-capo (PriceCapAdapterBase /
 * PriceCapAdapterStable) and CLSynchronicityPriceAdapter (peg-to-base).
 */
export const ADAPTER_FEED_GETTERS = ['BASE_TO_USD_AGGREGATOR', 'ASSET_TO_USD_AGGREGATOR', 'ASSET_TO_PEG', 'PEG_TO_BASE', 'aggregator'] as const;
const adapterAbi = ADAPTER_FEED_GETTERS.map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }) as const);
const pythAbi = [
  {
    type: 'function',
    name: 'getPriceUnsafe',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'tuple', components: [{ name: 'price', type: 'int64' }, { name: 'conf', type: 'uint64' }, { name: 'expo', type: 'int32' }, { name: 'publishTime', type: 'uint256' }] }],
  },
] as const;

export interface AggregatorRead {
  address: string;
  /**
   * chainlink   — answers latestRoundData itself (a feed or a feed proxy)
   * adapter     — answers latestAnswer and points at feed(s) underneath (Aave price-cap / peg adapters); its age
   *               is the OLDEST of those feeds
   * answer-only — answers a price but exposes no update time and no feed AEGIS recognises
   * none        — doesn't answer a price at all
   */
  kind?: 'chainlink' | 'adapter' | 'answer-only' | 'none';
  /** the source's own answer (USD) */
  answer: number | null;
  decimals: number | null;
  description: string | null;
  /** unix ms of the last update (for an adapter: of its oldest underlying feed); null = not exposed */
  updatedAt: number | null;
  /** adapter only: the feeds underneath */
  via?: Array<{ role: string; address: string; description: string | null; answer: number | null; updatedAt: number | null; under?: Array<{ role: string; address: string; description: string | null; updatedAt: number | null }> }>;
  /** the adapter reports its price cap as active (the protocol values the asset below its feed); null = not exposed */
  capped?: boolean | null;
  error: string | null;
}

export interface OracleSnapshot {
  block: number;
  /** chain time of the block (ms) */
  at: number;
  tydro: Array<{ symbol: string; asset: string; decimals: number; priceUsd: number | null; source: AggregatorRead | null }>;
  tydroBaseUnit: number | null;
  tydroFallback: string | null;
  nado: Array<{ productId: number; symbol: string | null; type: 'spot' | 'perp'; token: string | null; priceUsd: number | null }>;
  pyth: Array<{ key: string; id: string; price: number | null; conf: number | null; publishTime: number | null; error: string | null }>;
  errors: string[];
}

const ok = <T>(r: { ok: boolean; value?: unknown; error?: string } | undefined): T | null => (r && r.ok ? (r.value as T) : null);

const ZERO = '0x0000000000000000000000000000000000000000';
const PER_SOURCE = ['latestRoundData', 'latestAnswer', 'latestTimestamp', 'decimals', 'description', 'isCapped'] as const;

/** Read price sources; follow adapters (two levels at most) to the feeds underneath. */
async function readSources(client: PublicClient, addrs: string[], blockNumber: bigint, depth = 0): Promise<Map<string, AggregatorRead>> {
  const out = new Map<string, AggregatorRead>();
  if (!addrs.length) return out;
  const W = PER_SOURCE.length + ADAPTER_FEED_GETTERS.length;
  const calls: Call[] = addrs.flatMap((a) => [
    ...PER_SOURCE.map((fn) => ({ address: a as `0x${string}`, abi: aggregatorAbi, functionName: fn }) as Call),
    ...ADAPTER_FEED_GETTERS.map((fn) => ({ address: a as `0x${string}`, abi: adapterAbi, functionName: fn }) as Call),
  ]);
  const r = await multicallAdaptive(client, calls, { blockNumber, chunk: 60 });
  const found: Array<{ src: string; role: string; feed: string }> = [];
  addrs.forEach((a, i) => {
    const at = (k: number) => r[i * W + k];
    const round = ok<readonly [bigint, bigint, bigint, bigint, bigint]>(at(0));
    const ans = ok<bigint>(at(1));
    const ts = ok<bigint>(at(2));
    const dec = ok<number>(at(3));
    const desc = ok<string>(at(4));
    const capped = ok<boolean>(at(5));
    const feeds = ADAPTER_FEED_GETTERS.map((g, k) => ({ role: g, feed: ok<string>(at(PER_SOURCE.length + k))?.toLowerCase() ?? null })).filter(
      (x): x is { role: (typeof ADAPTER_FEED_GETTERS)[number]; feed: string } => !!x.feed && x.feed !== ZERO && x.feed !== a,
    );
    const raw = round ? round[1] : ans;
    const answer = raw !== null && dec !== null ? Number(raw) / 10 ** Number(dec) : null;
    const own = round && round[3] > 0n ? Number(round[3]) * 1000 : ts && ts > 0n ? Number(ts) * 1000 : null;
    // a Chainlink proxy also answers aggregator(): it is a feed, not an adapter
    const isAdapter = !round && feeds.length > 0;
    out.set(a, {
      address: a,
      kind: round ? 'chainlink' : isAdapter ? 'adapter' : raw !== null ? 'answer-only' : 'none',
      answer,
      decimals: dec !== null ? Number(dec) : null,
      description: desc,
      updatedAt: own,
      via: [],
      capped: capped,
      error: raw === null ? `answers neither latestRoundData nor latestAnswer (${(at(0) as { error?: string })?.error?.slice(0, 80) ?? 'failed'})` : null,
    });
    if (isAdapter && depth < 2) for (const f of feeds) found.push({ src: a, role: f.role, feed: f.feed });
  });
  if (found.length) {
    const under = await readSources(client, [...new Set(found.map((f) => f.feed))], blockNumber, depth + 1);
    for (const f of found) {
      const u = under.get(f.feed);
      const s = out.get(f.src)!;
      (s.via ??= []).push({
        role: f.role,
        address: f.feed,
        description: u?.description ?? null,
        answer: u?.answer ?? null,
        updatedAt: u?.updatedAt ?? null,
        ...(u?.via?.length ? { under: u.via.map((x) => ({ role: x.role, address: x.address, description: x.description, updatedAt: x.updatedAt })) } : {}),
      });
    }
    for (const s of out.values()) {
      if (s.kind !== 'adapter' || s.updatedAt !== null) continue;
      const times = (s.via ?? []).map((v) => v.updatedAt);
      // the oldest underlying feed decides the age; if any feed's time is unknown, the age is unknown
      s.updatedAt = times.length && times.every((t): t is number => t !== null) ? Math.min(...times) : null;
    }
  }
  return out;
}

export async function readOracleSnapshot(client: PublicClient, blockNumber: bigint): Promise<Result<OracleSnapshot>> {
  const errors: string[] = [];
  try {
    const blk = await client.getBlock({ blockNumber });
    const at = Number(blk.timestamp) * 1000;
    const assets = TYDRO_RESERVES.map((r) => r.underlying);
    const head: Call[] = [
      { address: TYDRO.ORACLE, abi: aaveOracleAbi, functionName: 'BASE_CURRENCY_UNIT' },
      { address: TYDRO.ORACLE, abi: aaveOracleAbi, functionName: 'getAssetsPrices', args: [assets] },
      { address: TYDRO.ORACLE, abi: aaveOracleAbi, functionName: 'getFallbackOracle' },
      ...assets.map((a) => ({ address: TYDRO.ORACLE, abi: aaveOracleAbi, functionName: 'getSourceOfAsset', args: [a] }) as Call),
      ...Object.values(PYTH.feeds).map((id) => ({ address: PYTH.address, abi: pythAbi, functionName: 'getPriceUnsafe', args: [id] }) as Call),
    ];
    const r1 = await multicallAdaptive(client, head, { blockNumber, chunk: 60 });
    const unit = ok<bigint>(r1[0]);
    const prices = ok<readonly bigint[]>(r1[1]);
    if (!unit || !prices) errors.push(`Tydro AaveOracle prices: ${!r1[1]?.ok ? (r1[1] as { error: string }).error : 'base unit missing'}`);
    const sources = assets.map((_, i) => ok<string>(r1[3 + i])?.toLowerCase() ?? null);
    const pythStart = 3 + assets.length;

    // each distinct source: the Chainlink interface, the plain answer, and the adapter getters
    const uniq = [...new Set(sources.filter((s): s is string => !!s && s !== ZERO))];
    const agg = await readSources(client, uniq, blockNumber);

    const tydro = TYDRO_RESERVES.map((r, i) => ({
      symbol: r.symbol,
      asset: r.underlying.toLowerCase(),
      decimals: r.decimals,
      priceUsd: unit && prices && prices[i] !== undefined ? Number(prices[i]) / Number(unit) : null,
      source: sources[i] ? (agg.get(sources[i]!) ?? null) : null,
    }));

    const pyth = Object.entries(PYTH.feeds).map(([key, id], i) => {
      const r = r1[pythStart + i];
      const v = ok<{ price: bigint; conf: bigint; expo: number; publishTime: bigint }>(r);
      if (!v) return { key, id, price: null, conf: null, publishTime: null, error: `unreadable on Ink (${(r as { error?: string })?.error?.slice(0, 80) ?? 'failed'})` };
      const scale = 10 ** Number(v.expo);
      return { key, id, price: Number(v.price) * scale, conf: Number(v.conf) * scale, publishTime: Number(v.publishTime) * 1000, error: null };
    });

    // Nado: every product with its oracle price (and spot token address) in one Querier call
    let nado: OracleSnapshot['nado'] = [];
    try {
      const info = (await client.readContract({
        address: NADO_CONTRACTS.querier,
        abi: QUERIER_GET_SUBACCOUNT_INFO_ABI as never,
        functionName: 'getSubaccountInfo' as never,
        args: [nadoSubaccount('0x0000000000000000000000000000000000000000')] as never,
        blockNumber,
      })) as unknown as {
        spotProducts: readonly { productId: number; oraclePriceX18: bigint; config: { token: string } }[];
        perpProducts: readonly { productId: number; oraclePriceX18: bigint }[];
      };
      nado = [
        ...info.spotProducts.map((p) => ({ productId: p.productId, symbol: NADO_PRODUCTS.get(p.productId)?.symbol ?? null, type: 'spot' as const, token: p.config.token.toLowerCase(), priceUsd: Number(p.oraclePriceX18) / 1e18 })),
        ...info.perpProducts.map((p) => ({ productId: p.productId, symbol: NADO_PRODUCTS.get(p.productId)?.symbol ?? null, type: 'perp' as const, token: null, priceUsd: Number(p.oraclePriceX18) / 1e18 })),
      ];
    } catch (e) {
      errors.push(`Nado oracle prices: ${errMessage(e).slice(0, 160)}`);
    }
    return Ok({ block: Number(blockNumber), at, tydro, tydroBaseUnit: unit ? Number(unit) : null, tydroFallback: ok<string>(r1[2])?.toLowerCase() ?? null, nado, pyth, errors });
  } catch (e) {
    return Err('RPC_DEAD', `oracle snapshot: ${errMessage(e)}`);
  }
}

/* ───────────────────────── protocol parameters (Protocol Change Monitor) ───────────────────────── */

const dataProviderAbi = [
  {
    type: 'function',
    name: 'getReserveConfigurationData',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bool' }, { type: 'bool' }, { type: 'bool' }],
  },
  { type: 'function', name: 'getReserveCaps', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'function', name: 'getPaused', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getDebtCeiling', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getLiquidationProtocolFee', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getInterestRateStrategyAddress', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'address' }] },
] as const;
const providerAbi = [
  { type: 'function', name: 'getPool', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getPoolConfigurator', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getPriceOracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getACLManager', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getACLAdmin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/** EIP-1967 implementation slot: a change = a contract upgrade. */
export const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

export interface ParamRead {
  /** stable key, e.g. "tydro:WETH:liquidationThreshold" */
  key: string;
  protocol: 'tydro' | 'nado';
  /** the asset/product it belongs to, or "protocol" */
  subject: string;
  name: string;
  value: string;
  /** contract + function the value was read from */
  source: string;
}

export interface ParamSnapshot {
  block: number;
  params: ParamRead[];
  /** parameters AEGIS tried to read but couldn't (not supported by the contract, or the read failed) — never claimed */
  unsupported: string[];
  /** Tydro's PoolConfigurator (where Tydro's admin changes are emitted), when readable */
  tydroConfigurator: string | null;
}

const s = (x: unknown) => (typeof x === 'bigint' ? x.toString() : typeof x === 'boolean' ? String(x) : String(x).toLowerCase());

export async function readProtocolParams(client: PublicClient, blockNumber: bigint): Promise<Result<ParamSnapshot>> {
  try {
    const params: ParamRead[] = [];
    const unsupported: string[] = [];
    const DP = TYDRO.AAVE_PROTOCOL_DATA_PROVIDER;
    const calls: Call[] = [];
    const meta: Array<(v: unknown) => void> = [];
    const fail: string[] = [];
    const push = (call: Call, label: string, take: (v: unknown) => void) => {
      calls.push(call);
      meta.push(take);
      fail.push(label);
    };
    const add = (protocol: 'tydro' | 'nado', subject: string, name: string, value: unknown, source: string) => params.push({ key: `${protocol}:${subject}:${name}`, protocol, subject, name, value: s(value), source });

    for (const r of TYDRO_RESERVES) {
      push({ address: DP, abi: dataProviderAbi, functionName: 'getReserveConfigurationData', args: [r.underlying] }, `tydro:${r.symbol}:configuration`, (v) => {
        const c = v as readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean];
        const src = 'AaveProtocolDataProvider.getReserveConfigurationData';
        add('tydro', r.symbol, 'ltv', c[1], src);
        add('tydro', r.symbol, 'liquidationThreshold', c[2], src);
        add('tydro', r.symbol, 'liquidationBonus', c[3], src);
        add('tydro', r.symbol, 'reserveFactor', c[4], src);
        add('tydro', r.symbol, 'usageAsCollateralEnabled', c[5], src);
        add('tydro', r.symbol, 'borrowingEnabled', c[6], src);
        add('tydro', r.symbol, 'isActive', c[8], src);
        add('tydro', r.symbol, 'isFrozen', c[9], src);
      });
      push({ address: DP, abi: dataProviderAbi, functionName: 'getReserveCaps', args: [r.underlying] }, `tydro:${r.symbol}:caps`, (v) => {
        const c = v as readonly [bigint, bigint];
        add('tydro', r.symbol, 'borrowCap', c[0], 'AaveProtocolDataProvider.getReserveCaps');
        add('tydro', r.symbol, 'supplyCap', c[1], 'AaveProtocolDataProvider.getReserveCaps');
      });
      push({ address: DP, abi: dataProviderAbi, functionName: 'getPaused', args: [r.underlying] }, `tydro:${r.symbol}:isPaused`, (v) => add('tydro', r.symbol, 'isPaused', v, 'AaveProtocolDataProvider.getPaused'));
      push({ address: DP, abi: dataProviderAbi, functionName: 'getDebtCeiling', args: [r.underlying] }, `tydro:${r.symbol}:debtCeiling`, (v) => add('tydro', r.symbol, 'debtCeiling', v, 'AaveProtocolDataProvider.getDebtCeiling'));
      push({ address: DP, abi: dataProviderAbi, functionName: 'getLiquidationProtocolFee', args: [r.underlying] }, `tydro:${r.symbol}:liquidationProtocolFee`, (v) => add('tydro', r.symbol, 'liquidationProtocolFee', v, 'AaveProtocolDataProvider.getLiquidationProtocolFee'));
      push({ address: DP, abi: dataProviderAbi, functionName: 'getInterestRateStrategyAddress', args: [r.underlying] }, `tydro:${r.symbol}:interestRateStrategy`, (v) =>
        add('tydro', r.symbol, 'interestRateStrategy', v, 'AaveProtocolDataProvider.getInterestRateStrategyAddress'),
      );
      push({ address: TYDRO.ORACLE, abi: aaveOracleAbi, functionName: 'getSourceOfAsset', args: [r.underlying] }, `tydro:${r.symbol}:oracleSource`, (v) => add('tydro', r.symbol, 'oracleSource', v, 'AaveOracle.getSourceOfAsset'));
    }
    let configurator: string | null = null;
    for (const fn of ['getPool', 'getPoolConfigurator', 'getPriceOracle', 'getACLManager', 'getACLAdmin'] as const) {
      push({ address: TYDRO.POOL_ADDRESSES_PROVIDER, abi: providerAbi, functionName: fn }, `tydro:protocol:${fn}`, (v) => {
        add('tydro', 'protocol', fn.replace(/^get/, '').replace(/^./, (c) => c.toLowerCase()), v, `PoolAddressesProvider.${fn}`);
        if (fn === 'getPoolConfigurator') configurator = s(v);
      });
    }
    const res = await multicallAdaptive(client, calls, { blockNumber, chunk: 80 });
    res.forEach((r, i) => (r.ok ? meta[i]!(r.value) : unsupported.push(fail[i]!)));

    // contract upgrades: EIP-1967 implementation slots
    const proxies: Array<[string, 'tydro' | 'nado', string]> = [
      [TYDRO.POOL, 'tydro', 'Pool'],
      ...(configurator ? ([[configurator, 'tydro', 'PoolConfigurator']] as Array<[string, 'tydro', string]>) : []),
      [NADO_CONTRACTS.clearinghouse, 'nado', 'Clearinghouse'],
      [NADO_CONTRACTS.endpoint, 'nado', 'Endpoint'],
      [NADO_CONTRACTS.spotEngine, 'nado', 'SpotEngine'],
      [NADO_CONTRACTS.perpEngine, 'nado', 'PerpEngine'],
      [NADO_CONTRACTS.querier, 'nado', 'Querier'],
    ];
    await Promise.all(
      proxies.map(async ([addr, protocol, name]) => {
        try {
          const raw = await client.getStorageAt({ address: addr as `0x${string}`, slot: EIP1967_IMPL_SLOT, blockNumber });
          const impl = raw ? `0x${raw.slice(-40)}` : '0x0000000000000000000000000000000000000000';
          add(protocol, 'protocol', `${name}.implementation`, impl === '0x0000000000000000000000000000000000000000' ? 'not a proxy (no EIP-1967 slot)' : impl, `eth_getStorageAt(${name}, EIP-1967 implementation slot)`);
        } catch {
          unsupported.push(`${protocol}:protocol:${name}.implementation`);
        }
      }),
    );

    // Nado: every product's risk weights and (spot) token — new products appear, removed ones disappear
    try {
      const info = (await client.readContract({
        address: NADO_CONTRACTS.querier,
        abi: QUERIER_GET_SUBACCOUNT_INFO_ABI as never,
        functionName: 'getSubaccountInfo' as never,
        args: [nadoSubaccount('0x0000000000000000000000000000000000000000')] as never,
        blockNumber,
      })) as unknown as {
        spotProducts: readonly { productId: number; risk: Record<string, bigint>; config: Record<string, unknown> }[];
        perpProducts: readonly { productId: number; risk: Record<string, bigint> }[];
      };
      const W = ['longWeightInitialX18', 'shortWeightInitialX18', 'longWeightMaintenanceX18', 'shortWeightMaintenanceX18'];
      const src = 'FQuerier.getSubaccountInfo (product risk)';
      for (const p of [...info.spotProducts.map((x) => ({ ...x, kind: 'spot' })), ...info.perpProducts.map((x) => ({ ...x, kind: 'perp' }))]) {
        const subject = `${NADO_PRODUCTS.get(p.productId)?.symbol ?? `product ${p.productId}`}#${p.productId}`;
        add('nado', subject, 'listed', `${p.kind}`, 'FQuerier.getSubaccountInfo (product list)');
        for (const w of W) add('nado', subject, w.replace('X18', ''), p.risk[w] !== undefined ? (Number(p.risk[w]) / 1e18).toString() : 'n/a', src);
        if ('config' in p) {
          const c = p.config as Record<string, unknown>;
          add('nado', subject, 'token', c.token, 'FQuerier.getSubaccountInfo (spot config)');
          for (const k of ['interestInflectionUtilX18', 'interestFloorX18', 'interestSmallCapX18', 'interestLargeCapX18', 'withdrawFeeX18', 'minDepositRateX18'])
            if (c[k] !== undefined) add('nado', subject, k.replace('X18', ''), (Number(c[k] as bigint) / 1e18).toString(), 'FQuerier.getSubaccountInfo (spot config)');
        }
      }
    } catch (e) {
      unsupported.push(`nado:products (${errMessage(e).slice(0, 80)})`);
    }
    return Ok({ block: Number(blockNumber), params: params.sort((a, b) => a.key.localeCompare(b.key)), unsupported, tydroConfigurator: configurator });
  } catch (e) {
    return Err('RPC_DEAD', `protocol parameters: ${errMessage(e)}`);
  }
}
