import { describe, expect, it } from 'vitest';
import { inkEvents, liquidationEvents, stressEvents, type AggPoint, type ChangeRecord, type LedgerRecord, type OracleWatch } from '../src/index.js';
import type { VerificationRecord } from '../src/verify.js';

const T = Date.UTC(2026, 9, 5);
const pt = (block: number, level: string | null): AggPoint =>
  ({ at: new Date(T + block * 1000).toISOString(), block, stress: level ? { level, confidence: 'NORMAL', version: 'stress-1.0.0', population: 100 } : null }) as unknown as AggPoint;
const liq = (i: number, wallet: string, at: number): LedgerRecord =>
  ({ id: `l${i}`, venue: 'tydro', tx: `0x${i}`, block: 100 + i, at, wallet, sizeBand: '1–10k', family: 'ETH', aegis: { before: { hullTemp: 'CRITICAL' } } }) as unknown as LedgerRecord;

describe('Ink event feed (one canonical, balance-free source for alerts and webhooks)', () => {
  it('stress events only on a level change between two measured points', () => {
    const e = stressEvents([pt(1, 'CALM'), pt(2, null), pt(3, 'CALM'), pt(4, 'ELEVATED'), pt(5, 'ELEVATED')]);
    expect(e.map((x) => x.id)).toEqual(['stress|4']);
    expect(e[0]!.data).toMatchObject({ from: 'CALM', to: 'ELEVATED' });
  });

  it('merges oracle, change, cascade and verification events; unique ids; newest first; since filter', () => {
    const watch = { kind: 'aegis-oracle-watch', rows: [], events: [{ id: 'x|peg|DEPEG|9', at: T + 50_000, block: 9, asset: '0xa', symbol: 'USDe', kind: 'peg', status: 'DEPEG', text: 'USDe: DEPEG' }] } as unknown as OracleWatch;
    const change = { id: 'tydro:WETH:ltv@10', key: 'tydro:WETH:ltv', protocol: 'tydro', subject: 'WETH', name: 'ltv', kind: 'changed', old: '8000', new: '7500', between: { fromBlock: 5, toBlock: 10, fromAt: T, toAt: T + 10_000 } } as unknown as ChangeRecord;
    const cascade = [0, 1, 2, 3].map((i) => liq(i, `0x${String(i).repeat(40)}`, T + 20_000 + i * 60_000));
    const fail = { venue: 'nado', case: 'Nado default subaccount', sourceType: 'on-chain', at: new Date(T + 30_000).toISOString(), block: 1, status: 'FAIL', failureReason: 'margin off by 3%', rulesVersion: 'v1.2.0' } as unknown as VerificationRecord;
    const notChecked = { ...fail, status: 'NOT_CHECKED', at: new Date(T + 31_000).toISOString() } as VerificationRecord;
    const all = inkEvents({ oracle: watch, changes: [change, change], liquidations: cascade, verification: [fail, notChecked] });
    expect(all.map((e) => e.type)).toEqual(['cascade.detected', 'oracle.depeg', 'verification.failed', 'protocol.parameter_changed']);
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect(inkEvents({ oracle: watch, changes: [change], since: T + 40_000 }).map((e) => e.type)).toEqual(['oracle.depeg']);
  });

  it('balance-free: data holds only flat scalars, no balances, health factors or liquidation prices', () => {
    const e = liquidationEvents([liq(1, '0x' + 'ab'.repeat(20), T)], new Set(['0x' + 'ab'.repeat(20)]));
    expect(e).toHaveLength(1);
    expect(e[0]!.data.sizeBand).toBe('1–10k');
    for (const v of Object.values(e[0]!.data)) expect(v === null || ['string', 'number', 'boolean'].includes(typeof v)).toBe(true);
    expect(JSON.stringify(e)).not.toMatch(/"(hf|healthFactor|balance|usd|collateralUsd|debtUsd|liquidationPrice)"/i);
    expect(liquidationEvents([liq(1, '0x' + 'ab'.repeat(20), T)], new Set())).toHaveLength(0);
  });
});
