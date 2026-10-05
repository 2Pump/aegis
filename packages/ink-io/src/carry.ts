/**
 * MARKET STATE FOR CARRY ANALYSIS (read-only view calls at one block). Release 4.
 *
 * Everything here is protocol state, read from the protocols' own contracts — no third-party API:
 *  - Tydro (AaveProtocolDataProvider.getReserveData / getReserveConfigurationData / getReserveCaps; underlying
 *    balanceOf(aToken) for available liquidity; AaveOracle prices). Rates are rays (1e27), annual, not compounded.
 *  - Nado (FQuerier.getSubaccountInfo — one call returns every product): spot deposit/borrow multipliers and totals,
 *    interest config, withdrawal fee; perp cumulative funding (longs / shorts), open interest, oracle price.
 *
 * Reading the same state at two blocks gives what was actually paid between them: interest from the change in
 * Tydro's indices or Nado's multipliers, funding from the change in Nado's cumulative funding. That is observed,
 * not modelled — and it can be read for any past block the RPC serves, so no backfill of our own is needed.
 * Every call may fail; a failure leaves that field null, never zero.
 */
import type { PublicClient } from 'viem';
import { multicallAdaptive, type Call } from './batch.js';
import { nadoSubaccount } from './address.js';
import { NADO_CONTRACTS, NADO_PRODUCTS, QUERIER_GET_SUBACCOUNT_INFO_ABI } from './nado-registry.js';
import { Err, Ok, errMessage, type Result } from './result.js';
import { TYDRO, TYDRO_RESERVES } from './tydro-registry.js';

const dpAbi = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [
      { name: 'unbacked', type: 'uint256' },
      { name: 'accruedToTreasuryScaled', type: 'uint256' },
      { name: 'totalAToken', type: 'uint256' },
      { name: 'totalStableDebt', type: 'uint256' },
      { name: 'totalVariableDebt', type: 'uint256' },
      { name: 'liquidityRate', type: 'uint256' },
      { name: 'variableBorrowRate', type: 'uint256' },
      { name: 'stableBorrowRate', type: 'uint256' },
      { name: 'averageStableBorrowRate', type: 'uint256' },
      { name: 'liquidityIndex', type: 'uint256' },
      { name: 'variableBorrowIndex', type: 'uint256' },
      { name: 'lastUpdateTimestamp', type: 'uint40' },
    ],
  },
  {
    type: 'function',
    name: 'getReserveConfigurationData',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bool' }, { type: 'bool' }, { type: 'bool' }],
  },
  { type: 'function', name: 'getReserveCaps', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
] as const;
const erc20Abi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const oracleAbi = [
  { type: 'function', name: 'BASE_CURRENCY_UNIT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getAssetsPrices', stateMutability: 'view', inputs: [{ type: 'address[]' }], outputs: [{ type: 'uint256[]' }] },
] as const;

export interface TydroMarket {
  symbol: string;
  asset: string;
  decimals: number;
  priceUsd: number | null;
  /** annual, not compounded (ray / 1e27); null = unreadable */
  supplyApr: number | null;
  borrowApr: number | null;
  /** cumulative indices (ray / 1e27) — interest actually accrued between two blocks is their ratio */
  liquidityIndex: number | null;
  borrowIndex: number | null;
  /** whole tokens */
  supplied: number | null;
  borrowed: number | null;
  /** underlying held by the aToken: what can actually be borrowed or withdrawn now (whole tokens) */
  available: number | null;
  /** whole tokens; 0 = no cap */
  supplyCap: number | null;
  borrowCap: number | null;
  /** basis points */
  ltv: number | null;
  liquidationThreshold: number | null;
  borrowingEnabled: boolean | null;
  isActive: boolean | null;
  isFrozen: boolean | null;
}

export interface NadoSpotMarket {
  productId: number;
  symbol: string | null;
  token: string;
  priceUsd: number;
  depositMultiplier: number;
  borrowMultiplier: number;
  /** whole tokens */
  deposits: number;
  borrows: number;
  /** flat fee per withdrawal, in the token (whole tokens) */
  withdrawFee: number;
  longWeightMaintenance: number;
  shortWeightMaintenance: number;
}

export interface NadoPerpMarket {
  productId: number;
  symbol: string | null;
  priceUsd: number;
  /** quote paid per 1 unit of base since launch, by longs / received by shorts (whole quote units) */
  cumFundingLong: number;
  cumFundingShort: number;
  /** base units */
  openInterest: number;
  longWeightMaintenance: number;
  shortWeightMaintenance: number;
}

export interface CarryPoint {
  block: number;
  /** chain time (ms) */
  at: number;
  tydro: TydroMarket[];
  nado: { spot: NadoSpotMarket[]; perp: NadoPerpMarket[] } | null;
  errors: string[];
}

const RAY = 1e27;
const X18 = 1e18;
const f18 = (x: bigint) => Number(x) / X18;
const ok = <T>(r: { ok: boolean; value?: unknown } | undefined): T | null => (r && r.ok ? (r.value as T) : null);

export async function readCarryPoint(client: PublicClient, blockNumber: bigint): Promise<Result<CarryPoint>> {
  const errors: string[] = [];
  try {
    const blk = await client.getBlock({ blockNumber });
    const at = Number(blk.timestamp) * 1000;
    const R = TYDRO_RESERVES;
    const W = 4;
    const calls: Call[] = [
      { address: TYDRO.ORACLE, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT' },
      { address: TYDRO.ORACLE, abi: oracleAbi, functionName: 'getAssetsPrices', args: [R.map((r) => r.underlying)] },
      ...R.flatMap((r) => [
        { address: TYDRO.AAVE_PROTOCOL_DATA_PROVIDER, abi: dpAbi, functionName: 'getReserveData', args: [r.underlying] } as Call,
        { address: TYDRO.AAVE_PROTOCOL_DATA_PROVIDER, abi: dpAbi, functionName: 'getReserveConfigurationData', args: [r.underlying] } as Call,
        { address: TYDRO.AAVE_PROTOCOL_DATA_PROVIDER, abi: dpAbi, functionName: 'getReserveCaps', args: [r.underlying] } as Call,
        { address: r.underlying as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [r.aToken] } as Call,
      ]),
    ];
    const res = await multicallAdaptive(client, calls, { blockNumber, chunk: 60 });
    const unit = ok<bigint>(res[0]);
    const prices = ok<readonly bigint[]>(res[1]);
    if (!unit || !prices) errors.push('Tydro prices unreadable');
    const tydro: TydroMarket[] = R.map((r, i) => {
      const base = 2 + i * W;
      const rd = ok<readonly bigint[]>(res[base]);
      const cfg = ok<readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean]>(res[base + 1]);
      const caps = ok<readonly [bigint, bigint]>(res[base + 2]);
      const bal = ok<bigint>(res[base + 3]);
      if (!rd) errors.push(`Tydro ${r.symbol}: reserve data unreadable`);
      const d = 10 ** r.decimals;
      return {
        symbol: r.symbol,
        asset: r.underlying.toLowerCase(),
        decimals: r.decimals,
        priceUsd: unit && prices && prices[i] !== undefined ? Number(prices[i]) / Number(unit) : null,
        supplyApr: rd ? Number(rd[5]) / RAY : null,
        borrowApr: rd ? Number(rd[6]) / RAY : null,
        liquidityIndex: rd ? Number(rd[9]) / RAY : null,
        borrowIndex: rd ? Number(rd[10]) / RAY : null,
        supplied: rd ? Number(rd[2]) / d : null,
        borrowed: rd ? (Number(rd[3]) + Number(rd[4])) / d : null,
        available: bal !== null ? Number(bal) / d : null,
        supplyCap: caps ? Number(caps[1]) : null,
        borrowCap: caps ? Number(caps[0]) : null,
        ltv: cfg ? Number(cfg[1]) : null,
        liquidationThreshold: cfg ? Number(cfg[2]) : null,
        borrowingEnabled: cfg ? cfg[6] : null,
        isActive: cfg ? cfg[8] : null,
        isFrozen: cfg ? cfg[9] : null,
      };
    });

    let nado: CarryPoint['nado'] = null;
    try {
      const info = (await client.readContract({
        address: NADO_CONTRACTS.querier,
        abi: QUERIER_GET_SUBACCOUNT_INFO_ABI as never,
        functionName: 'getSubaccountInfo' as never,
        args: [nadoSubaccount('0x0000000000000000000000000000000000000000')] as never,
        blockNumber,
      })) as unknown as {
        spotProducts: readonly {
          productId: number;
          oraclePriceX18: bigint;
          risk: { longWeightMaintenanceX18: bigint; shortWeightMaintenanceX18: bigint };
          config: { token: string; withdrawFeeX18: bigint };
          state: { cumulativeDepositsMultiplierX18: bigint; cumulativeBorrowsMultiplierX18: bigint; totalDepositsNormalized: bigint; totalBorrowsNormalized: bigint };
        }[];
        perpProducts: readonly {
          productId: number;
          oraclePriceX18: bigint;
          risk: { longWeightMaintenanceX18: bigint; shortWeightMaintenanceX18: bigint };
          state: { cumulativeFundingLongX18: bigint; cumulativeFundingShortX18: bigint; openInterest: bigint };
        }[];
      };
      nado = {
        spot: info.spotProducts.map((p) => {
          const dm = f18(p.state.cumulativeDepositsMultiplierX18);
          const bm = f18(p.state.cumulativeBorrowsMultiplierX18);
          return {
            productId: p.productId,
            symbol: NADO_PRODUCTS.get(p.productId)?.symbol ?? null,
            token: p.config.token.toLowerCase(),
            priceUsd: f18(p.oraclePriceX18),
            depositMultiplier: dm,
            borrowMultiplier: bm,
            deposits: f18(p.state.totalDepositsNormalized) * dm,
            borrows: f18(p.state.totalBorrowsNormalized) * bm,
            withdrawFee: f18(p.config.withdrawFeeX18),
            longWeightMaintenance: f18(p.risk.longWeightMaintenanceX18),
            shortWeightMaintenance: f18(p.risk.shortWeightMaintenanceX18),
          };
        }),
        perp: info.perpProducts.map((p) => ({
          productId: p.productId,
          symbol: NADO_PRODUCTS.get(p.productId)?.symbol ?? null,
          priceUsd: f18(p.oraclePriceX18),
          cumFundingLong: f18(p.state.cumulativeFundingLongX18),
          cumFundingShort: f18(p.state.cumulativeFundingShortX18),
          openInterest: f18(p.state.openInterest),
          longWeightMaintenance: f18(p.risk.longWeightMaintenanceX18),
          shortWeightMaintenance: f18(p.risk.shortWeightMaintenanceX18),
        })),
      };
    } catch (e) {
      errors.push(`Nado markets: ${errMessage(e).slice(0, 160)}`);
    }
    return Ok({ block: Number(blockNumber), at, tydro, nado, errors });
  } catch (e) {
    return Err('RPC_DEAD', `carry point: ${errMessage(e)}`);
  }
}

/**
 * The first block at or after a time (ms), found by stepping on the chain's own timestamps — never assumed.
 * Ink makes about one block a second; a few corrections land within `toleranceS`. Returns the block and its time.
 */
export async function blockAtTime(client: PublicClient, atMs: number, head: { block: number; at: number }, toleranceS = 30): Promise<Result<{ block: number; at: number }>> {
  try {
    let b = Math.max(1, head.block - Math.round((head.at - atMs) / 1000));
    let rate = 1; // blocks per second, refined from what the chain reports
    for (let i = 0; i < 6; i++) {
      const blk = await client.getBlock({ blockNumber: BigInt(b) });
      const t = Number(blk.timestamp) * 1000;
      const diffS = (atMs - t) / 1000;
      if (Math.abs(diffS) <= toleranceS) return Ok({ block: b, at: t });
      if (head.block !== b && head.at !== t) rate = Math.max(0.1, Math.min(10, (head.block - b) / ((head.at - t) / 1000)));
      b = Math.max(1, Math.min(head.block, b + Math.round(diffS * rate)));
    }
    return Err('RPC_DEAD', `no block within ${toleranceS}s of ${new Date(atMs).toISOString()}`);
  } catch (e) {
    return Err('RPC_DEAD', `block at time: ${errMessage(e)}`);
  }
}

/** OP-stack GasPriceOracle predeploy (the same address on every OP-stack chain, Ink included). */
export const OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const;
const gpoAbi = [{ type: 'function', name: 'getL1FeeUpperBound', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const;

export interface GasRead {
  /** L2 execution gas price (wei) */
  gasPriceWei: number | null;
  /** upper bound of the L1 data fee for one transaction of `txBytes` bytes (wei); null = not exposed */
  l1FeeUpperBoundWei: number | null;
  txBytes: number;
}

/** Ink's current gas price and the L1 data fee bound for a typical transaction. Failures are null, never zero. */
export async function readGas(client: PublicClient, blockNumber: bigint, txBytes = 300): Promise<GasRead> {
  const [gp, l1] = await Promise.all([
    client.getGasPrice().then(Number).catch(() => null),
    client
      .readContract({ address: OP_GAS_PRICE_ORACLE, abi: gpoAbi, functionName: 'getL1FeeUpperBound', args: [BigInt(txBytes)], blockNumber })
      .then(Number)
      .catch(() => null),
  ]);
  return { gasPriceWei: gp, l1FeeUpperBoundWei: l1, txBytes };
}
