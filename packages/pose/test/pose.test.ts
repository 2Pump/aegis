import { describe, expect, it } from 'vitest';
import { classify, type Book } from '../src/index.js';
import carry from '../../../fixtures/carry.json';
import naked from '../../../fixtures/naked.json';
import equityMargin from '../../../fixtures/equity-margin.json';
import wounded from '../../../fixtures/wounded.json';
import dark from '../../../fixtures/dark.json';
import empty from '../../../fixtures/empty.json';

const b = (x: unknown) => x as Book;

describe('dossier worked examples', () => {
  it('EX1 CARRY — kBTC spot $10k, BTC short perp $10k, hf 2.1 → primary CARRY, not NAKED, hull NOMINAL', () => {
    const p = classify(b(carry));
    expect(p.primary).toBe('CARRY');
    expect(p.tags).not.toContain('NAKED');
    expect(p.hullTemp).toBe('NOMINAL');
    expect(p.darkReasons).toEqual([]);
    const btc = p.metrics.families.find((f) => f.family === 'BTC');
    expect(btc?.S).toBeCloseTo(10_000);
    expect(btc?.P).toBeCloseTo(10_000);
    expect(p.reasons.some((r) => r.startsWith('CARRY · BTC'))).toBe(true);
  });

  it('EX2 NAKED — BTC long perp $10k on $3k USDT0 → NAKED (+ LEVERED possible)', () => {
    const p = classify(b(naked));
    expect(p.primary).toBe('NAKED');
    expect(p.tags).toContain('LEVERED'); // 10,000 / 3,000 = 3.33× ≥ 3×
    expect(p.tags).not.toContain('CARRY');
  });

  it('EX3 EQUITY-MARGIN — SPYx collateral $8k, ETH long perp $5k → EQUITY-MARGIN + NAKED', () => {
    const p = classify(b(equityMargin));
    expect(p.primary).toBe('EQUITY-MARGIN');
    expect(p.tags).toContain('NAKED');
    expect(p.metrics.eq).toBeCloseTo(8_000);
  });

  it('EX4 WOUNDED CARRY — EX1 with hf 1.12 → CARRY + WOUNDED, hull CRITICAL', () => {
    const p = classify(b(wounded));
    expect(p.primary).toBe('CARRY');
    expect(p.tags).toContain('WOUNDED');
    expect(p.tags.indexOf('WOUNDED')).toBe(1); // overlay sits right after primary
    expect(p.hullTemp).toBe('CRITICAL');
  });

  it('EX5 DARK — Nado fetch failed, Tydro ok → DARK with NADO_SENSOR in darkReasons', () => {
    const p = classify(b(dark));
    expect(p.primary).toBe('DARK');
    expect(p.darkReasons.some((r) => r.startsWith('NADO_SENSOR'))).toBe(true);
    expect(p.tags).not.toContain('CARRY');
    expect(p.tags).not.toContain('NAKED');
    expect(p.residualDeltaUsd).toBeNull(); // never guess S or P from half a book
    expect(p.hullTemp).toBe('UNKNOWN');
  });

  it('EX6 EMPTY — zero positions → EMPTY', () => {
    const p = classify(b(empty));
    expect(p.primary).toBe('EMPTY');
    expect(p.tags).toEqual(['EMPTY']);
  });
});

describe('edge behavior', () => {
  it('DARK sensor with a readable wound still reports CRITICAL', () => {
    const d = structuredClone(b(dark));
    if (d.tydro.status === 'OK') d.tydro.data.hf = 1.05;
    const p = classify(d);
    expect(p.tags).toEqual(['DARK', 'WOUNDED']);
    expect(p.hullTemp).toBe('CRITICAL');
  });

  it('CARRY outside the 15% band is not CARRY, and the short perp becomes NAKED', () => {
    const c = structuredClone(b(carry));
    if (c.nado.status === 'OK') {
      const perp = c.nado.data.perps[0]!;
      perp.sizeBase = -0.12; // $12k short vs $10k spot → gap 16.7%
      perp.notionalUsd = -12_000;
    }
    const p = classify(c);
    expect(p.tags).not.toContain('CARRY');
    expect(p.tags).toContain('NAKED');
  });

  it('HF between 1.25 and 1.5 is ELEVATED, not CRITICAL', () => {
    const c = structuredClone(b(carry));
    if (c.tydro.status === 'OK') c.tydro.data.hf = 1.4;
    const p = classify(c);
    expect(p.hullTemp).toBe('ELEVATED');
    expect(p.tags).not.toContain('WOUNDED');
  });

  it('Tydro-only supplier is LOCKED', () => {
    const e = structuredClone(b(empty));
    if (e.tydro.status === 'OK') {
      e.tydro.data.supplies = [
        { symbol: 'USDG', family: 'USD', assetClass: 'STABLE', amount: 500, usd: 500, priceUsd: 1, priceSource: 'FIXTURE' },
      ];
    }
    const p = classify(e);
    expect(p.primary).toBe('LOCKED');
    expect(p.tags).toContain('STABLE-BALLAST');
  });

  it('negative Nado maintenance health is WOUNDED', () => {
    const n = structuredClone(b(naked));
    if (n.nado.status === 'OK') n.nado.data.maintenance = { assetsUsd: 3000, liabilitiesUsd: 3100, healthUsd: -100 };
    const p = classify(n);
    expect(p.tags).toContain('WOUNDED');
    expect(p.hullTemp).toBe('CRITICAL');
  });
});

describe('plate readability', () => {
  it('reasons are ordered like tags — primary first', () => {
    const p = classify(b(equityMargin));
    expect(p.reasons[0]).toMatch(/^EQUITY-MARGIN ·/);
    expect(p.reasons[1]).toMatch(/^NAKED ·/);
  });
});

/* ── v1.1: same-family loops and HOLD ─────────────────────────────────────────── */
import emptyFx from '../../../fixtures/empty.json';
import type { Leg, NadoSpot } from '../src/index.js';

const leg = (symbol: string, family: string, assetClass: Leg['assetClass'], usd: number): Leg => ({
  symbol, family, assetClass, amount: usd, usd, priceUsd: 1, priceSource: 'TYDRO_ORACLE',
});
function tydroBook(supplies: Leg[], debts: Leg[], hf: number | null): Book {
  const x = structuredClone(b(emptyFx));
  if (x.tydro.status === 'OK') {
    x.tydro.data.supplies = supplies;
    x.tydro.data.debts = debts;
    x.tydro.data.hf = hf;
    x.tydro.data.totalCollateralUsd = supplies.reduce((s, l) => s + l.usd, 0);
    x.tydro.data.totalDebtUsd = debts.reduce((s, l) => s + l.usd, 0);
  }
  return x;
}

describe('v1.1 same-family Tydro loops', () => {
  const sUSDe = leg('sUSDe', 'USD', 'STABLE', 10_000);
  const usdt = leg('USDT0', 'USD', 'STABLE', 9_400);

  it('a sUSDe → USDT loop at HF 1.06 is NOT wounded (only a depeg can liquidate it) and sits in the warn band', () => {
    const p = classify(tydroBook([sUSDe], [usdt], 1.06));
    expect(p.metrics.correlatedFamily).toBe('USD');
    expect(p.tags).not.toContain('WOUNDED');
    expect(p.hullTemp).toBe('ELEVATED'); // 1.06 < 1.08
    expect(p.reasons.some((r) => r.startsWith('NOTE · same-family USD loop'))).toBe(true);
  });

  it('the same loop at HF 1.02 IS wounded, and says it is ~2% depeg from liquidation', () => {
    const p = classify(tydroBook([sUSDe], [usdt], 1.02));
    expect(p.tags).toContain('WOUNDED');
    expect(p.hullTemp).toBe('CRITICAL');
    expect(p.metrics.wound).toEqual({ tydro: true, nado: false });
    expect(p.reasons.find((r) => r.startsWith('WOUNDED ·'))).toMatch(/same-family USD loop.*2\.0% depeg/);
  });

  it('an ETH loop (weETH → WETH) is a loop too; HF 1.12 is nominal-warn, not wounded', () => {
    const p = classify(tydroBook([leg('weETH', 'ETH', 'CRYPTO', 5_000)], [leg('WETH', 'ETH', 'CRYPTO', 4_400)], 1.12));
    expect(p.metrics.correlatedFamily).toBe('ETH');
    expect(p.tags).not.toContain('WOUNDED');
    expect(p.hullTemp).toBe('NOMINAL'); // 1.12 ≥ 1.08
  });

  it('mixed families (WETH collateral, USDC debt) keep the normal 1.25 line', () => {
    const p = classify(tydroBook([leg('WETH', 'ETH', 'CRYPTO', 5_000)], [leg('USDC', 'USD', 'STABLE', 3_500)], 1.2));
    expect(p.metrics.correlatedFamily).toBeNull();
    expect(p.tags).toContain('WOUNDED');
    expect(p.metrics.wound.tydro).toBe(true);
  });

  it('dust in another family does not break the loop; a real second family does', () => {
    const dust = leg('WETH', 'ETH', 'CRYPTO', 4);
    expect(classify(tydroBook([sUSDe, dust], [usdt], 1.06)).metrics.correlatedFamily).toBe('USD');
    const real = leg('WETH', 'ETH', 'CRYPTO', 400);
    expect(classify(tydroBook([sUSDe, real], [usdt], 1.06)).metrics.correlatedFamily).toBeNull();
  });

  it('no debt → not a loop', () => {
    expect(classify(tydroBook([sUSDe], [], null)).metrics.correlatedFamily).toBeNull();
  });
});

describe('v1.1 HOLD', () => {
  function nadoSpotBook(spots: Array<[string, string, Leg['assetClass'], number]>): Book {
    const x = structuredClone(b(emptyFx));
    if (x.nado.status === 'OK') {
      x.nado.data.spots = spots.map(([symbol, family, assetClass, usd], i): NadoSpot => ({
        ...leg(symbol, family, assetClass, usd), priceSource: 'NADO_ONCHAIN', productId: i + 1, subaccount: '0xsub',
      }));
      x.nado.data.equityUsd = spots.reduce((s, r) => s + r[3], 0);
    }
    return x;
  }

  it('someone who just holds ETH on Nado (no perps, no debt) is HOLD, not NO RULE', () => {
    const p = classify(nadoSpotBook([['WETH', 'ETH', 'CRYPTO', 1_500]]));
    expect(p.primary).toBe('HOLD');
    expect(p.reasons[0]).toMatch(/^HOLD · non-stable assets \$1,500 held outright/);
  });

  it('a small non-stable Tydro supply below the LOCKED line is HOLD', () => {
    expect(classify(tydroBook([leg('WETH', 'ETH', 'CRYPTO', 30)], [], null)).primary).toBe('HOLD');
  });

  it('HOLD never outranks another pose: a bigger Tydro supply stays LOCKED, kBTC-heavy stays KBTC-CORE', () => {
    expect(classify(tydroBook([leg('WETH', 'ETH', 'CRYPTO', 3_000)], [], null)).primary).toBe('LOCKED');
    const p = classify(nadoSpotBook([['KBTC', 'BTC', 'CRYPTO', 5_000]]));
    expect(p.primary).toBe('KBTC-CORE');
    expect(p.tags).toContain('HOLD');
  });

  it('any debt or any perp rules HOLD out', () => {
    expect(classify(tydroBook([leg('WETH', 'ETH', 'CRYPTO', 30)], [leg('USDC', 'USD', 'STABLE', 15)], 1.6)).tags).not.toContain('HOLD');
    expect(classify(nadoSpotBook([['WETH', 'ETH', 'CRYPTO', 1_500], ['USDT0', 'USD', 'STABLE', -50]])).tags).not.toContain('HOLD');
  });

  it('mostly stables is still STABLE-BALLAST, not HOLD', () => {
    expect(classify(nadoSpotBook([['USDT0', 'USD', 'STABLE', 5_000], ['WETH', 'ETH', 'CRYPTO', 200]])).primary).toBe('STABLE-BALLAST');
  });
});

describe('v1.2 same-family Nado loops (from two real wounded wallets, 2026-09-29)', () => {
  function nadoBook(spots: Array<[string, string, Leg['assetClass'], number]>, buffer: number, perpUsd = 0): Book {
    const x = structuredClone(b(emptyFx));
    if (x.nado.status === 'OK') {
      x.nado.data.spots = spots.map(([symbol, family, assetClass, usd], i): NadoSpot => ({
        ...leg(symbol, family, assetClass, usd), priceSource: 'NADO_ONCHAIN', productId: i, subaccount: '0xsub',
      }));
      x.nado.data.perps = perpUsd
        ? [{ productId: 2, subaccount: '0xsub', symbol: 'ETH-PERP', family: 'ETH', assetClass: 'CRYPTO', sizeBase: perpUsd / 2600, notionalUsd: perpUsd, priceUsd: 2600, priceSource: 'NADO_ONCHAIN', vQuoteUsd: -perpUsd, unsettledUsd: 0 } as never]
        : [];
      const assets = 22_400;
      x.nado.data.maintenance = { assetsUsd: assets, liabilitiesUsd: 0, healthUsd: assets * buffer };
      x.nado.data.equityUsd = spots.reduce((s, r) => s + r[3], 0);
    }
    return x;
  }
  const loop = (buffer: number) => nadoBook([['USDC', 'USD', 'STABLE', 22_650], ['USDT0', 'USD', 'STABLE', -21_967]], buffer);

  it('the real wallet at a 2.0% buffer is still WOUNDED — closer than the 3% depeg line', () => {
    const p = classify(loop(0.02));
    expect(p.metrics.correlatedNadoFamily).toBe('USD');
    expect(p.tags).toContain('WOUNDED');
    expect(p.metrics.wound).toEqual({ tydro: false, nado: true });
    expect(p.reasons.find((r) => r.startsWith('WOUNDED ·'))).toMatch(/same-family USD loop/);
  });

  it('the same loop at a 5% buffer is no longer wounded (was, under the 10% line), and sits in the 8% warn band', () => {
    const p = classify(loop(0.05));
    expect(p.tags).not.toContain('WOUNDED');
    expect(p.hullTemp).toBe('ELEVATED');
  });

  it('a perp, or an unknown token, means it is not a pure loop → the normal 10% line', () => {
    expect(classify(nadoBook([['USDC', 'USD', 'STABLE', 22_650], ['USDT0', 'USD', 'STABLE', -21_967]], 0.05, 5_000)).tags).toContain('WOUNDED');
    const unknown = nadoBook([['USDC', 'USD', 'STABLE', 22_650], ['USDT0', 'USD', 'STABLE', -21_967], ['SPOT#11', 'SPOT#11', 'CRYPTO', 531]], 0.05);
    expect(classify(unknown).metrics.correlatedNadoFamily).toBeNull();
    expect(classify(unknown).tags).toContain('WOUNDED');
  });

  it('no borrowing → not a loop', () => {
    expect(classify(nadoBook([['USDC', 'USD', 'STABLE', 22_650]], 0.05)).metrics.correlatedNadoFamily).toBeNull();
  });
});
