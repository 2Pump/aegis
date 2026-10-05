import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { TYDRO_RESERVES, blockAtTime, readCarryPoint, type CarryPoint } from '@aegis/ink-io';
import { CARRY, CARRY_DAYS, CARRY_LATEST, CARRY_RATE, FORBIDDEN_WORDS, buildCarry, type CarryFile, type ChangeRecord, type OracleWatch } from '../src/index.js';
import { fileStore, recordCarry } from '../src/node/index.js';

import { D, T0, history, okWatch, point, type Rates } from './carry-fixture.js';

const S = (f: CarryFile, id: string) => {
  const s = f.structures.find((x) => x.id === id);
  if (!s) throw new Error(`no structure ${id}: ${f.structures.map((x) => x.id).join(', ')}`);
  return s;
};
const factor = (f: CarryFile, id: string, key: string) => S(f, id).factors.find((x) => x.key === key)!;
const ccEth = 'cc-nado-3-4';

describe('observed rates (from indices, multipliers and cumulative funding)', () => {
  it('index and multiplier changes give back the rates that were paid', () => {
    const a = point(0);
    const b = point(7);
    expect(CARRY_RATE.tydroSupply('USDT')(a, b)).toBeCloseTo(0.05, 6);
    expect(CARRY_RATE.tydroBorrow('USDT')(a, b)).toBeCloseTo(0.07, 6);
    expect(CARRY_RATE.nadoDeposit(0)(a, b)).toBeCloseTo(0.04, 6);
    expect(CARRY_RATE.fundingShort(4)(a, b)).toBeCloseTo(0.1, 6);
  });
});

describe('Carry structures', () => {
  it('positive funding: a short receives it; net = deposit + funding; current Tydro rate is the contract’s, Nado’s is observed', () => {
    const f = buildCarry({ head: point(30), days: history(30), oracle: okWatch, nowMs: T0 + 30 * D });
    const s = S(f, ccEth);
    expect(s.funding).toBeCloseTo(0.1, 6);
    expect(s.net).toBeCloseTo(0.01 + 0.1, 3);
    expect(s.windows.d7.net).toBeCloseTo(0.11, 3);
    expect(s.components.find((c) => c.kind === 'funding')!.basis).toMatch(/observed since the last daily checkpoint/);
    expect(S(f, 'lend-tydro-USDT').components[0]!.basis).toMatch(/current rate published by the contract/);
    expect(factor(f, ccEth, 'funding-reversal').risk).toBe('LOW');
  });

  it('negative funding: the short pays — the funding contribution is negative and lowers the net', () => {
    const f = buildCarry({ head: point(30, { funding: { 4: () => -0.05 } }), days: history(30, { funding: { 4: () => -0.05 } }), oracle: okWatch, nowMs: T0 + 30 * D });
    const s = S(f, ccEth);
    expect(s.funding).toBeCloseTo(-0.05, 6);
    expect(s.net).toBeCloseTo(0.01 - 0.05, 3);
    expect(factor(f, ccEth, 'funding-reversal').risk).toBe('HIGH');
  });

  it('funding reversal: positive on average but against the short on several days → counted, and the range shows it', () => {
    const flip = { 4: (d: number) => (d % 5 === 0 ? -0.3 : 0.15) };
    const f = buildCarry({ head: point(29.5, { funding: flip }), days: history(30, { funding: flip }), oracle: okWatch, nowMs: T0 + 29.5 * D });
    const fr = factor(f, ccEth, 'funding-reversal');
    expect(fr.text).toMatch(/on 6 of the last 29 recorded days/);
    expect(fr.risk).toBe('MEDIUM');
    expect(S(f, ccEth).range.min!).toBeLessThan(0);
    expect(S(f, ccEth).range.max!).toBeGreaterThan(0.15);
  });

  it('borrow cost: the borrowed-hedge structure pays Tydro’s USDT0 borrow rate on its borrowed share', () => {
    const f = buildCarry({ head: point(30), days: history(30), oracle: okWatch, nowMs: T0 + 30 * D });
    const s = S(f, 'bh-WETH');
    const b = 0.8 * CARRY.BORROW_SHARE_OF_LTV; // 0.4
    expect(s.borrowCost).toBeCloseTo(0.07 * b, 6);
    expect(s.gross).toBeCloseTo(0.02 + 0.04 * b, 3);
    expect(s.net).toBeCloseTo(0.02 + 0.04 * b - 0.07 * b + 0.1, 3);
  });

  it('borrowed hedge uses the stablecoin Tydro lets you borrow now (USDT0 off → USDC) with Nado’s own margin weight', () => {
    const mk = (d: number) => {
      const p = point(d);
      p.tydro.find((t) => t.symbol === 'USDT')!.borrowingEnabled = false;
      const usdc = p.tydro.find((t) => t.symbol === 'USDC')!;
      p.nado!.spot.push({ productId: 5, symbol: 'USDC', token: usdc.asset, priceUsd: 1, depositMultiplier: 1 + 0.01 * (d / 365), borrowMultiplier: 1 + 0.03 * (d / 365), deposits: 4e6, borrows: 1e6, withdrawFee: 1, longWeightMaintenance: 0.98, shortWeightMaintenance: 1.02 });
      return p;
    };
    const f = buildCarry({ head: mk(30), days: Array.from({ length: 30 }, (_, i) => mk(i)), oracle: okWatch, nowMs: T0 + 30 * D });
    const s = S(f, 'bh-WETH');
    expect(s.title).toBe('Supply WETH on Tydro, borrow USDC as Nado margin, short ETH-PERP');
    expect(s.borrowCost).toBeCloseTo(0.065 * 0.4, 6);
    expect(s.liquidation.pctUp).toBeCloseTo(((1 + 0.4 * 0.98) / 1.05 - 1) * 100, 6);
    expect(factor(f, 'bh-WETH', 'protocol-change').risk).not.toBe('HIGH');
    // nothing borrowable at all → the structure stays, flagged HIGH with the reason
    const none = (d: number) => {
      const p = mk(d);
      p.tydro.find((t) => t.symbol === 'USDC')!.borrowingEnabled = false;
      return p;
    };
    const g = buildCarry({ head: none(30), days: Array.from({ length: 30 }, (_, i) => none(i)), oracle: okWatch, nowMs: T0 + 30 * D });
    expect(factor(g, 'bh-WETH', 'protocol-change').text).toMatch(/borrowing USDT is disabled on Tydro/);
    expect(S(g, 'bh-WETH').risk).toBe('HIGH');
  });

  it('tokenized equities: Nado spot and perps are named, and the note says they are not Tydro collateral', () => {
    const p = point(30);
    p.nado!.spot.push({ productId: 40, symbol: 'wAAPLx', token: '0x' + 'a'.repeat(40), priceUsd: 230, depositMultiplier: 1, borrowMultiplier: 1, deposits: 100, borrows: 0, withdrawFee: 0.003, longWeightMaintenance: 0.8, shortWeightMaintenance: 1.2 });
    p.nado!.perp.push({ productId: 41, symbol: 'AAPL-PERP', priceUsd: 230, cumFundingLong: 0, cumFundingShort: 0, openInterest: 10, longWeightMaintenance: 0.9, shortWeightMaintenance: 1.1 });
    const f = buildCarry({ head: p, days: history(30), nowMs: T0 + 30 * D });
    expect(f.equities).toMatch(/spot \(wAAPLx\) and as perps \(AAPL-PERP\)\. None is Tydro collateral/);
  });

  it('utilization and available liquidity are reported per Tydro market', () => {
    const f = buildCarry({ head: point(30), days: history(30), nowMs: T0 + 30 * D });
    const usdt = f.markets.tydro.find((m) => m.symbol === 'USDT0')!;
    expect(usdt.utilization).toBeCloseTo(0.6, 6);
    expect(usdt.availableUsd).toBeCloseTo(400_000, 0);
    expect(usdt.supply7).toBeCloseTo(0.05, 3);
  });

  it('capacity constraint: a near-full supply cap or thin liquidity is the binding limit, and a frozen market blocks it', () => {
    const head = point(30);
    const usdt = head.tydro.find((t) => t.symbol === 'USDT')!;
    usdt.supplied = 1_950_000;
    const weth = head.tydro.find((t) => t.symbol === 'WETH')!;
    weth.isFrozen = true;
    const f = buildCarry({ head, days: history(30), oracle: okWatch, nowMs: T0 + 30 * D });
    expect(S(f, 'lend-tydro-USDT').capacity.usd).toBeCloseTo(50_000, 0);
    expect(factor(f, 'lend-tydro-USDT', 'capacity').risk).toBe('HIGH');
    expect(factor(f, 'cc-tydro-WETH', 'protocol-change').risk).toBe('HIGH');
    expect(factor(f, 'cc-tydro-WETH', 'protocol-change').text).toMatch(/frozen/);
  });

  it('missing fee: Nado trading fees are listed as missing (never assumed zero) and make the structure PARTIAL', () => {
    const f = buildCarry({ head: point(30), days: history(31), oracle: okWatch, gas: { gasPriceWei: 1_000_000, l1FeeUpperBoundWei: 2_000_000_000, txBytes: 300 }, nowMs: T0 + 30 * D });
    const s = S(f, ccEth);
    expect(s.fees.missing.join(' ')).toMatch(/Nado trading fee/);
    expect(s.fees.items.join(' ')).toMatch(/Nado withdrawal fee WETH/);
    expect(s.fees.oneOffUsd).not.toBeNull();
    expect(S(f, 'lend-tydro-USDT').fees.missing).toHaveLength(0);
    const noGas = buildCarry({ head: point(30), days: history(31), nowMs: T0 + 30 * D });
    expect(S(noGas, 'lend-tydro-USDT').fees.oneOffUsd).toBeNull();
    expect(S(noGas, 'lend-tydro-USDT').fees.missing.join(' ')).toMatch(/gas cost/);
  });

  it('stale rate: a reading over 3 h old makes the data factor HIGH; no history yet means no windows, never zeros', () => {
    const f = buildCarry({ head: point(30), days: history(30), oracle: okWatch, nowMs: T0 + 30 * D + 5 * 3_600_000 });
    expect(factor(f, ccEth, 'data').risk).toBe('HIGH');
    const fresh = buildCarry({ head: point(0.5), days: [], oracle: okWatch, nowMs: T0 + 0.5 * D });
    const s = S(fresh, ccEth);
    expect(s.net).toBeNull(); // Nado has no current rate and no 24 h window yet
    expect(s.completeness).toBe('UNAVAILABLE');
    expect(s.windows.d7.net).toBeNull();
    expect(S(fresh, 'lend-tydro-USDT').net).toBeCloseTo(0.05, 6); // Tydro publishes its current rate
    expect(S(fresh, 'lend-tydro-USDT').completeness).toBe('PARTIAL');
  });

  it('stablecoin risk follows Oracle Watch’s peg status of what is held', () => {
    const f = buildCarry({ head: point(30), days: history(30), oracle: { ...okWatch, rows: [...okWatch.rows.filter((r) => r.symbol !== 'USDe'), { symbol: 'USDe', status: 'DEPEG' }] } as OracleWatch, nowMs: T0 + 30 * D });
    expect(factor(f, 'lend-tydro-USDe', 'stablecoin').risk).toBe('HIGH');
    expect(factor(f, 'lend-tydro-USDC', 'stablecoin').risk).toBe('LOW');
    expect(S(f, 'lend-tydro-USDe').risk).toBe('HIGH');
    const none = buildCarry({ head: point(30), days: history(30), nowMs: T0 + 30 * D });
    expect(factor(none, 'lend-tydro-USDC', 'oracle').risk).toBe('UNKNOWN');
  });

  it('liquidation sensitivity comes from the protocols’ own weights and thresholds; two-sided for the borrowed hedge', () => {
    const f = buildCarry({ head: point(30), days: history(30), oracle: okWatch, nowMs: T0 + 30 * D });
    const nado = S(f, ccEth).liquidation;
    expect(nado.pctUp).toBeCloseTo((1 / (1.05 - 0.95) - 1) * 100, 6); // 900%
    expect(nado.pctDown).toBeNull();
    const t = S(f, 'cc-tydro-WETH').liquidation;
    expect(t.pctUp).toBeCloseTo((1.5 / 1.05 - 1) * 100, 6); // ~42.9%
    expect(factor(f, 'cc-tydro-WETH', 'liquidation').risk).toBe('MEDIUM');
    const bh = S(f, 'bh-WETH').liquidation;
    expect(bh.pctDown).toBeCloseTo((1 - 0.4 / 0.83) * 100, 6);
    expect(bh.pctUp).toBeCloseTo((1.4 / 1.05 - 1) * 100, 6);
    expect(S(f, 'lend-tydro-USDC').liquidation.text).toMatch(/no liquidation path/);
  });

  it('protocol change risk: a recorded change to an involved market in the last 30 days is MEDIUM', () => {
    const change = { subject: 'WETH', between: { toAt: T0 + 25 * D } } as unknown as ChangeRecord;
    const f = buildCarry({ head: point(30), days: history(30), oracle: okWatch, changes: [change], nowMs: T0 + 30 * D });
    expect(factor(f, 'cc-tydro-WETH', 'protocol-change').risk).toBe('MEDIUM');
    expect(factor(f, 'lend-tydro-USDC', 'protocol-change').risk).toBe('LOW');
  });

  it('a missed day is a gap, never stretched into one day', () => {
    const days = history(10).filter((p) => p.at !== T0 + 5 * D);
    const f = buildCarry({ head: point(9.5), days, nowMs: T0 + 9.5 * D });
    expect(f.history.days).toBe(7); // 9 checkpoints, one 48 h pair skipped
    expect(f.history.gaps).toBe(1);
  });

  it('no "guaranteed" language anywhere in what is published; APR, not APY', () => {
    const f = buildCarry({ head: point(30), days: history(30), oracle: okWatch, nowMs: T0 + 30 * D });
    expect(JSON.stringify(f)).not.toMatch(FORBIDDEN_WORDS);
    expect(JSON.stringify(f.methodology)).toMatch(/APR/);
  });

  it('no execution path: the published file has no links, actions or calldata — only sources by contract and function', () => {
    const f = buildCarry({ head: point(30), days: history(30), oracle: okWatch, nowMs: T0 + 30 * D });
    const j = JSON.stringify(f);
    expect(j).not.toMatch(/https?:\/\//);
    expect(j).not.toMatch(/calldata|approve\(|"action"|"href"/i);
  });
});

/* ───────────────────────── reader + writer (fake chain) ───────────────────────── */

/** Fake Ink: one block a second from genesis T0−40d; state at each block = point(day) of DEFAULT rates. */
function fakeChain(opts: { archiveFrom?: number } = {}) {
  const GENESIS = T0 - 40 * D;
  const tsOf = (b: number) => Math.floor(GENESIS / 1000) + b;
  const dayOf = (b: number) => (tsOf(b) * 1000 - T0) / D;
  const enc = (p: CarryPoint, fn: string, args: unknown[] | undefined, address: string): unknown => {
    const t = p.tydro.find((x) => args && String(args[0]).toLowerCase() === x.asset);
    const ray = (x: number) => BigInt(Math.round(x * 1e9)) * 10n ** 18n;
    if (fn === 'BASE_CURRENCY_UNIT') return 100_000_000n;
    if (fn === 'getAssetsPrices') return p.tydro.map((x) => BigInt(Math.round(x.priceUsd! * 1e8)));
    if (fn === 'getReserveData' && t) {
      const d = 10n ** BigInt(t.decimals);
      return [0n, 0n, BigInt(Math.round(t.supplied!)) * d, 0n, BigInt(Math.round(t.borrowed!)) * d, ray(t.supplyApr!), ray(t.borrowApr!), 0n, 0n, ray(t.liquidityIndex!), ray(t.borrowIndex!), 0n];
    }
    if (fn === 'getReserveConfigurationData' && t) return [18n, 8000n, 8300n, 10500n, 1000n, true, true, false, true, false];
    if (fn === 'getReserveCaps' && t) return [0n, BigInt(Math.round(t.supplyCap!))];
    if (fn === 'balanceOf') {
      const r = TYDRO_RESERVES.find((x) => x.underlying.toLowerCase() === address.toLowerCase())!;
      const m = p.tydro.find((x) => x.symbol === r.symbol)!;
      return BigInt(Math.round(m.available!)) * 10n ** BigInt(m.decimals);
    }
    throw new Error('revert');
  };
  const x18 = (v: number) => BigInt(Math.round(v * 1e9)) * 10n ** 9n;
  return {
    calls: { reads: 0 },
    client: {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(tsOf(Number(blockNumber))) }),
      getGasPrice: async () => 1_000_000n,
      multicall: async ({ contracts, blockNumber }: { contracts: Array<{ functionName: string; address: string; args?: unknown[] }>; blockNumber: bigint }) => {
        const p = point(dayOf(Number(blockNumber)));
        return contracts.map((c) => {
          try {
            return { status: 'success', result: enc(p, c.functionName, c.args, c.address) };
          } catch {
            return { status: 'failure', error: new Error('execution reverted') };
          }
        });
      },
      readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
        if (functionName === 'getL1FeeUpperBound') return 2_000_000_000n;
        if (opts.archiveFrom !== undefined && Number(blockNumber) < opts.archiveFrom) throw new Error('missing trie node (state not available)');
        const p = point(dayOf(Number(blockNumber)));
        return {
          spotProducts: p.nado!.spot.map((s) => ({
            productId: s.productId,
            oraclePriceX18: x18(s.priceUsd),
            risk: { longWeightMaintenanceX18: x18(s.longWeightMaintenance), shortWeightMaintenanceX18: x18(s.shortWeightMaintenance) },
            config: { token: s.token, withdrawFeeX18: x18(s.withdrawFee) },
            state: { cumulativeDepositsMultiplierX18: x18(s.depositMultiplier), cumulativeBorrowsMultiplierX18: x18(s.borrowMultiplier), totalDepositsNormalized: x18(s.deposits / s.depositMultiplier), totalBorrowsNormalized: x18(s.borrows / s.borrowMultiplier) },
          })),
          perpProducts: p.nado!.perp.map((q) => ({
            productId: q.productId,
            oraclePriceX18: x18(q.priceUsd),
            risk: { longWeightMaintenanceX18: x18(q.longWeightMaintenance), shortWeightMaintenanceX18: x18(q.shortWeightMaintenance) },
            state: { cumulativeFundingLongX18: x18(q.cumFundingLong), cumulativeFundingShortX18: x18(q.cumFundingShort), openInterest: x18(q.openInterest) },
          })),
        };
      },
    } as unknown as PublicClient,
    headBlock: (day: number) => Math.round((T0 + day * D - GENESIS) / 1000),
  };
}

describe('reader + writer (fake chain)', () => {
  it('reads rates, indices, liquidity and Nado markets at a block; finds the block at a time from chain timestamps', async () => {
    const c = fakeChain();
    const r = await readCarryPoint(c.client, BigInt(c.headBlock(10)));
    if (!r.ok) throw new Error(r.error.message);
    const usdt = r.value.tydro.find((t) => t.symbol === 'USDT')!;
    expect(usdt.supplyApr).toBeCloseTo(0.05, 6);
    expect(usdt.available).toBeCloseTo(400_000, 0);
    expect(usdt.ltv).toBe(8000);
    expect(r.value.nado?.perp.find((p) => p.productId === 4)?.cumFundingShort).toBeGreaterThan(0);
    const b = await blockAtTime(c.client, T0 + 3 * D, { block: c.headBlock(10), at: T0 + 10 * D });
    if (!b.ok) throw new Error(b.error.message);
    expect(Math.abs(b.value.at - (T0 + 3 * D))).toBeLessThanOrEqual(30_000);
  });

  it('fills daily checkpoints once (idempotent, bounded per run) and publishes the analysis', async () => {
    const c = fakeChain();
    const store = fileStore(mkdtempSync(join(tmpdir(), 'aegis-carry-')));
    const logs: string[] = [];
    await recordCarry({ store, client: c.client, head: c.headBlock(12.5), log: (m) => logs.push(m), nowMs: T0 + 12.5 * D, maxNewDays: 5 });
    const d1 = (await store.get(CARRY_DAYS)) as { points: Record<string, unknown> };
    expect(Object.keys(d1.points)).toHaveLength(5); // bounded
    await recordCarry({ store, client: c.client, head: c.headBlock(12.6), log: (m) => logs.push(m), nowMs: T0 + 12.6 * D });
    const d2 = (await store.get(CARRY_DAYS)) as { points: Record<string, unknown> };
    expect(Object.keys(d2.points).length).toBe(CARRY.DAYS + 1); // every wanted day, each read once
    const f = (await store.get(CARRY_LATEST)) as CarryFile;
    expect(S(f, ccEth).windows.d7.net).toBeCloseTo(0.11, 4);
    expect(f.gas.perTxUsd).not.toBeNull();
    expect(logs.some((l) => /carry: \d+ structures/.test(l))).toBe(true);
  });

  it('an RPC without old state: recent days are kept, the failure is logged, nothing is filled with zeros', async () => {
    const cutoff = fakeChain().headBlock(9.9);
    const c2 = fakeChain({ archiveFrom: cutoff });
    const store = fileStore(mkdtempSync(join(tmpdir(), 'aegis-carry-')));
    const logs: string[] = [];
    await recordCarry({ store, client: c2.client, head: c2.headBlock(12.5), log: (m) => logs.push(m), nowMs: T0 + 12.5 * D });
    const d = (await store.get(CARRY_DAYS)) as { points: Record<string, unknown> };
    expect(Object.keys(d.points).sort()).toEqual(['2026-10-11', '2026-10-12', '2026-10-13']);
    expect(logs.join('\n')).toMatch(/day\(s\) not readable/);
    const f = (await store.get(CARRY_LATEST)) as CarryFile;
    expect(S(f, ccEth).windows.d7.net).toBeNull();
    expect(S(f, ccEth).windows.d1.net).not.toBeNull();
  });
});
