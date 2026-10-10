import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { TYDRO_RESERVES } from '@aegis/ink-io';
import { eModeThresholds } from '../src/node/verify-run.js';

const USER = ('0x' + '6'.repeat(40)) as `0x${string}`;
const syrup = TYDRO_RESERVES.find((r) => /syrup/i.test(r.symbol)) ?? TYDRO_RESERVES[0]!;
const other = TYDRO_RESERVES.find((r) => r !== syrup)!;
const idOf = (a: string) => TYDRO_RESERVES.findIndex((r) => r.underlying === a);

function client(o: { category: number; v32: boolean }): PublicClient {
  return {
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      switch (functionName) {
        case 'getUserEMode':
          return BigInt(o.category);
        case 'getEModeCategoryCollateralConfig':
          if (!o.v32) throw new Error('execution reverted: function not found');
          return { ltv: 9000, liquidationThreshold: 9300, liquidationBonus: 10200 };
        case 'getEModeCategoryCollateralBitmap':
          if (!o.v32) throw new Error('execution reverted');
          return 1n << BigInt(idOf(syrup.underlying));
        case 'getReserveData':
          return { id: idOf(args![0] as string) };
        case 'getEModeCategoryData':
          return { ltv: 9000, liquidationThreshold: 9250, liquidationBonus: 10200, priceSource: '0x0000000000000000000000000000000000000000', label: 'Stablecoins' };
        case 'getReserveEModeCategory':
          return (args![0] as string) === syrup.underlying ? BigInt(o.category) : 0n;
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

describe('Tydro checker: E-Mode thresholds', () => {
  it('a wallet outside E-Mode uses the standard thresholds', async () => {
    expect(await eModeThresholds(client({ category: 0, v32: true }), USER, 1n)).toBeNull();
  });
  it('v3.2 layout: only the assets in the category bitmap get its threshold', async () => {
    const r = (await eModeThresholds(client({ category: 2, v32: true }), USER, 1n))!;
    expect(r.category).toBe(2);
    expect(r.layout).toMatch(/v3\.2/);
    expect(r.lt.get(syrup.underlying.toLowerCase())).toBe(9300);
    expect(r.lt.has(other.underlying.toLowerCase())).toBe(false);
  });
  it('v3.0 layout: assets whose own category matches get the category threshold', async () => {
    const r = (await eModeThresholds(client({ category: 1, v32: false }), USER, 1n))!;
    expect(r.layout).toMatch(/v3\.0/);
    expect(r.lt.get(syrup.underlying.toLowerCase())).toBe(9250);
    expect(r.lt.has(other.underlying.toLowerCase())).toBe(false);
  });
});
