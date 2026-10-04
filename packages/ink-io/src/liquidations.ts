/**
 * Actual liquidations on Ink, from the protocols' own on-chain events (read-only getLogs).
 *
 *  Tydro  Pool.LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user,
 *                             uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)
 *         — Aave v3's event, unchanged in the Tydro white-label (Pool 0x2816…FEbA, aave-address-book).
 *  Nado   Clearinghouse.Liquidation(bytes32 indexed liquidatorSubaccount, bytes32 indexed liquidateeSubaccount,
 *                             uint32 productId, bool isEncodedSpread, int128 amount, int128 amountQuote)
 *         — the event the census has used for discovery since 2026-09-28.
 *
 * Decoding is strict: a log that doesn't have the expected shape is skipped and counted, never half-read.
 */
import type { Log, PublicClient } from 'viem';
import { toEventSelector } from 'viem';
import { familyOf } from '@aegis/pose';
import { NADO_CONTRACTS, NADO_PRODUCTS } from './nado-registry.js';
import { TYDRO, TYDRO_RESERVES } from './tydro-registry.js';
import { TOPIC, scanLogs, type ScanOpts } from './logs.js';

export const LIQ_TOPIC = {
  tydro: toEventSelector('LiquidationCall(address,address,address,uint256,uint256,address,bool)'),
  nado: TOPIC.liquidation,
} as const;

export const LIQ_SOURCES = {
  tydro: { contract: TYDRO.POOL, event: 'LiquidationCall(address,address,address,uint256,uint256,address,bool)' },
  nado: { contract: NADO_CONTRACTS.clearinghouse, event: 'Liquidation(bytes32,bytes32,uint32,bool,int128,int128)' },
} as const;

/** One liquidation exactly as the event states it (raw integers as decimal strings; no prices). */
export type RawLiquidation =
  | {
      venue: 'tydro';
      id: string; // `${tx}:${logIndex}`
      tx: string;
      logIndex: number;
      block: number;
      user: string;
      collateral: { asset: string; symbol: string | null; family: string | null; decimals: number | null; amount: string };
      debt: { asset: string; symbol: string | null; family: string | null; decimals: number | null; amount: string };
      liquidator: string;
      receiveAToken: boolean;
    }
  | {
      venue: 'nado';
      id: string;
      tx: string;
      logIndex: number;
      block: number;
      /** the liquidated subaccount, and its owner (first 20 bytes) */
      subaccount: string;
      user: string;
      liquidatorSubaccount: string;
      productId: number;
      symbol: string | null;
      family: string | null;
      isEncodedSpread: boolean;
      /** signed base amount and quote amount as emitted (x18) */
      amountX18: string;
      amountQuoteX18: string;
    };

const reserveOf = new Map(TYDRO_RESERVES.map((r) => [r.underlying.toLowerCase(), r]));
const addr = (t: string | undefined) => (t && t.length === 66 ? `0x${t.slice(26)}`.toLowerCase() : null);
const word = (data: string, i: number) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const int128 = (w: string) => {
  const v = BigInt(`0x${w}`);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
};

export function decodeLiquidations(logs: readonly Log[]): { liquidations: RawLiquidation[]; skipped: number } {
  const out: RawLiquidation[] = [];
  let skipped = 0;
  for (const l of logs) {
    const t0 = l.topics[0];
    const tx = (l.transactionHash ?? '').toLowerCase();
    const logIndex = Number(l.logIndex ?? -1);
    const block = Number(l.blockNumber ?? -1);
    const data = l.data ?? '0x';
    if (!tx || logIndex < 0 || block < 0) {
      skipped++;
      continue;
    }
    if (t0 === LIQ_TOPIC.tydro && (l.address ?? '').toLowerCase() === TYDRO.POOL.toLowerCase()) {
      const c = addr(l.topics[1]);
      const d = addr(l.topics[2]);
      const u = addr(l.topics[3]);
      if (!c || !d || !u || data.length < 2 + 64 * 4) {
        skipped++;
        continue;
      }
      const rc = reserveOf.get(c);
      const rd = reserveOf.get(d);
      out.push({
        venue: 'tydro',
        id: `${tx}:${logIndex}`,
        tx,
        logIndex,
        block,
        user: u,
        collateral: { asset: c, symbol: rc?.symbol ?? null, family: rc ? familyOf(rc.symbol).family : null, decimals: rc?.decimals ?? null, amount: BigInt(`0x${word(data, 1)}`).toString() },
        debt: { asset: d, symbol: rd?.symbol ?? null, family: rd ? familyOf(rd.symbol).family : null, decimals: rd?.decimals ?? null, amount: BigInt(`0x${word(data, 0)}`).toString() },
        liquidator: `0x${word(data, 2).slice(24)}`.toLowerCase(),
        receiveAToken: BigInt(`0x${word(data, 3)}`) !== 0n,
      });
    } else if (t0 === LIQ_TOPIC.nado && (l.address ?? '').toLowerCase() === NADO_CONTRACTS.clearinghouse.toLowerCase()) {
      const liquidator = l.topics[1]?.toLowerCase();
      const liquidatee = l.topics[2]?.toLowerCase();
      if (!liquidator || !liquidatee || liquidatee.length !== 66 || data.length < 2 + 64 * 4) {
        skipped++;
        continue;
      }
      const productId = Number(BigInt(`0x${word(data, 0)}`));
      const p = NADO_PRODUCTS.get(productId);
      out.push({
        venue: 'nado',
        id: `${tx}:${logIndex}`,
        tx,
        logIndex,
        block,
        subaccount: liquidatee,
        user: liquidatee.slice(0, 42),
        liquidatorSubaccount: liquidator,
        productId,
        symbol: p?.symbol ?? null,
        family: p ? familyOf(p.symbol).family : null,
        isEncodedSpread: BigInt(`0x${word(data, 1)}`) !== 0n,
        amountX18: int128(word(data, 2)).toString(),
        amountQuoteX18: int128(word(data, 3)).toString(),
      });
    }
  }
  return { liquidations: out, skipped };
}

/** Both venues' liquidation events in one adaptive, resumable scan. */
export function scanLiquidations(client: PublicClient, fromBlock: number, toBlock: number, o: Partial<ScanOpts> = {}) {
  return scanLogs(client, { ...o, address: [TYDRO.POOL, NADO_CONTRACTS.clearinghouse], topics: [[LIQ_TOPIC.tydro, LIQ_TOPIC.nado]], fromBlock, toBlock });
}
