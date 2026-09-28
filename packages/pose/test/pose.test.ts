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
