import { describe, expect, it } from 'vitest';
import {
  DIRECTIONS,
  canBeLiquidated,
  classify,
  confidenceOf,
  directionById,
  directionScenario,
  familyOf,
  riskTemp,
  shockBook,
  stressState,
  thresholds,
  type Book,
  type HealthTriple,
  type NadoPerp,
  type NadoSpot,
} from '../src/index.js';
import carry from '../../../fixtures/carry.json';

/*
 * Pressure Map fixtures: made-up books, never real accounts. Nado maintenance triples are built from the same
 * per-position contributions the engine uses (c = weight × value + v_quote), so each book is self-consistent.
 */
type SpotIn = [symbol: string, usd: number, weight?: number, sub?: string, productId?: number];
type PerpIn = [symbol: string, notionalUsd: number, vQuoteUsd: number, weight?: number, sub?: string];
interface In {
  tydro?: { supplies?: Array<[string, number]>; debts?: Array<[string, number]>; lt?: number } | 'DARK';
  nado?: { spots?: SpotIn[]; perps?: PerpIn[] } | 'DARK';
}

const leg = (symbol: string, usd: number) => {
  const { family, assetClass } = familyOf(symbol);
  return { symbol, family, assetClass, amount: usd, usd, priceUsd: 1, priceSource: 'FIXTURE' as const };
};

function mk(i: In): Book {
  const dark = { status: 'DARK' as const, code: 'RPC_DEAD' as const, message: 'fixture', asOfTime: 0 };
  let tydro: Book['tydro'] = dark;
  if (i.tydro !== 'DARK') {
    const t = i.tydro ?? {};
    const supplies = (t.supplies ?? []).map(([s, u]) => leg(s, u));
    const debts = (t.debts ?? []).map(([s, u]) => leg(s, u));
    const S = supplies.reduce((a, l) => a + l.usd, 0), D = debts.reduce((a, l) => a + l.usd, 0);
    const lt = t.lt ?? 0.8;
    tydro = { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { hf: D > 0 ? (S * lt) / D : null, supplies, debts, totalCollateralUsd: S, totalDebtUsd: D, usdNet: S - D, liquidationThreshold: lt, notes: [] } };
  }
  let nado: Book['nado'] = dark;
  if (i.nado !== 'DARK') {
    const n = i.nado ?? {};
    const spots: NadoSpot[] = (n.spots ?? []).map(([s, u, w, sub, pid]) => ({ ...leg(s, u), productId: pid ?? (s === 'USDT0' ? 0 : 99), subaccount: sub ?? 'main', maintWeight: w ?? (u >= 0 ? 0.9 : 1.1) }));
    const perps: NadoPerp[] = (n.perps ?? []).map(([s, notional, vq, w, sub]) => {
      const { family, assetClass } = familyOf(s);
      return { productId: 2, subaccount: sub ?? 'main', symbol: s, family, assetClass, sizeBase: notional / 100, notionalUsd: notional, priceUsd: 100, priceSource: 'FIXTURE', vQuoteUsd: vq, unsettledUsd: vq + notional, maintWeight: w ?? (notional >= 0 ? 0.95 : 1.05) };
    });
    const subs = [...new Set([...spots.map((x) => x.subaccount), ...perps.map((x) => x.subaccount)])];
    const triple = (sub: string): HealthTriple => {
      const cs = [...spots.filter((x) => x.subaccount === sub).map((x) => x.maintWeight! * x.usd), ...perps.filter((x) => x.subaccount === sub).map((p) => p.maintWeight! * p.notionalUsd + p.vQuoteUsd)];
      return { assetsUsd: cs.reduce((a, c) => a + Math.max(c, 0), 0), liabilitiesUsd: cs.reduce((a, c) => a + Math.max(-c, 0), 0), healthUsd: cs.reduce((a, c) => a + c, 0) };
    };
    const subHealth = subs.map((s) => ({ subaccount: s, maintenance: triple(s) }));
    let maintenance: HealthTriple | null = null;
    let worst = Infinity;
    for (const { maintenance: m } of subHealth) {
      const b = m.assetsUsd > 0 ? m.healthUsd / m.assetsUsd : m.healthUsd < 0 ? -1 : Infinity;
      if (b < worst) (worst = b), (maintenance = m);
    }
    const equityUsd = spots.reduce((a, l) => a + l.usd, 0) + perps.reduce((a, p) => a + p.unsettledUsd, 0);
    nado = { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { subaccounts: subs, equityUsd, spots, perps, maintenance, initial: null, unweighted: null, funding: [], notes: [], subHealth } };
  }
  return { address: '0x00000000000000000000000000000000000f1x7e', source: 'FIXTURE', tydro, nado, asOfBlock: 1, asOfTime: 0 };
}

const dir = (id: string) => directionById(id)!;
const down = (id: string) => (p: number) => directionScenario(dir(id), -p);
const up = (id: string) => (p: number) => directionScenario(dir(id), p);

const F = {
  hedged: mk({ nado: { spots: [['USDT0', 2_000], ['KBTC', 10_000]], perps: [['BTC-PERP', -10_000, 10_000]] } }),
  unhedgedLong: mk({ nado: { spots: [['USDT0', 3_000]], perps: [['BTC-PERP', 10_000, -10_000]] } }),
  unhedgedShort: mk({ nado: { spots: [['USDT0', 3_000]], perps: [['BTC-PERP', -10_000, 10_000]] } }),
  levered: mk({ nado: { spots: [['USDT0', 1_000]], perps: [['ETH-PERP', 10_000, -10_000]] } }),
  tydroBorrower: mk({ tydro: { supplies: [['WETH', 10_000]], debts: [['USDC', 5_000]], lt: 0.8 }, nado: {} }),
  isolated: mk({ nado: { spots: [['USDT0', 20_000, 1, 'main'], ['USDT0', 600, 1, 'iso']], perps: [['ETH-PERP', 5_000, -5_000, 0.95, 'iso']] } }),
  stableLoop: mk({ tydro: { supplies: [['USDe', 10_000]], debts: [['USDT', 8_400]], lt: 0.9 }, nado: {} }),
  ethLoop: mk({ tydro: { supplies: [['weETH', 10_000]], debts: [['WETH', 7_000]], lt: 0.9 }, nado: {} }),
  stocks: mk({ nado: { spots: [['USDT0', -5_000], ['wSPYx', 8_000, 0.8]] } }), // USDT0 borrowed against wSPYx
  kbtc: mk({ tydro: { supplies: [['kBTC', 10_000]], debts: [['USDC', 4_000]], lt: 0.75 }, nado: {} }),
  nearNow: mk({ tydro: { supplies: [['WETH', 10_000]], debts: [['USDC', 7_300]], lt: 0.8 }, nado: {} }),
  smallDrop: mk({ tydro: { supplies: [['WETH', 10_000]], debts: [['USDC', 6_100]], lt: 0.8 }, nado: {} }),
  missingPrice: (() => {
    const b = mk({ tydro: { supplies: [['WETH', 10_000]], debts: [['USDC', 5_000]] }, nado: {} });
    if (b.tydro.status === 'OK') b.tydro.data.supplies[0]!.priceUsd = 0;
    return b;
  })(),
  partial: mk({ tydro: { supplies: [['WETH', 10_000]], debts: [['USDC', 5_000]] }, nado: 'DARK' }),
  empty: mk({ nado: {} }),
};

describe('scenario engine — integrity', () => {
  it('a zero move changes nothing: the shocked copy classifies exactly like the reading (no drift from the live rules)', () => {
    for (const [name, b] of Object.entries(F)) {
      expect(classify(shockBook(b, {})), name).toEqual(classify(b));
    }
    expect(classify(shockBook(carry as unknown as Book, {}))).toEqual(classify(carry as unknown as Book));
  });

  it('riskTemp (the fast path the scenarios use) agrees with classify on every fixture, at many moves', () => {
    for (const [name, b] of Object.entries(F)) {
      for (const d of DIRECTIONS) for (const p of [-40, -20, -7, 0, 7, 20, 40]) {
        const x = shockBook(b, directionScenario(d, p));
        expect(riskTemp(x), `${name} ${d.id} ${p}`).toBe(classify(x).hullTemp);
      }
    }
  });

  it('never mutates the canonical book', () => {
    const before = JSON.stringify(F.tydroBorrower);
    shockBook(F.tydroBorrower, directionScenario(dir('ETH'), -40));
    expect(JSON.stringify(F.tydroBorrower)).toBe(before);
  });

  it('clamps nonsense input instead of producing nonsense', () => {
    const b = shockBook(F.tydroBorrower, { families: { ETH: Number.NaN } });
    expect(stressState(b)).toEqual(stressState(F.tydroBorrower));
    const wiped = shockBook(F.tydroBorrower, { families: { ETH: -9 } }); // clamped to −95%
    expect(stressState(wiped).liquidatable).toBe(true);
  });
});

describe('scenario engine — Tydro', () => {
  it('borrower: hf 1.6 → Watch at −7% (hf < 1.5), Near at −22% (hf < 1.25), liquidatable at −38% (hf < 1)', () => {
    expect(thresholds(F.tydroBorrower, down('ETH'))).toEqual({ WATCH: 7, NEAR: 22, LIQ: 38 });
  });
  it('the debt side reprices too: a stablecoin depeg shrinks USDC debt and helps', () => {
    expect(thresholds(F.tydroBorrower, (p) => directionScenario(dir('USDC'), -p))).toEqual({ WATCH: null, NEAR: null, LIQ: null });
  });
  it('kBTC-backed: BTC down hurts, ETH down does nothing', () => {
    const t = thresholds(F.kbtc, down('BTC'));
    expect(t.NEAR).not.toBeNull();
    expect(thresholds(F.kbtc, down('ETH'))).toEqual({ WATCH: null, NEAR: null, LIQ: null });
  });
  it('already near liquidation reports 0; a wallet one small step away reports a small move', () => {
    expect(thresholds(F.nearNow, down('ETH')).NEAR).toBe(0);
    expect(thresholds(F.smallDrop, down('ETH')).NEAR).toBeLessThanOrEqual(5);
  });
  it('ETH-family loop (weETH on WETH): an ETH move moves both sides, so it never gets closer', () => {
    expect(thresholds(F.ethLoop, down('ETH'))).toEqual({ WATCH: null, NEAR: null, LIQ: null });
  });
  it('stablecoin loop: all stables moving together does nothing; USDe losing its peg alone is what endangers it, judged by the tighter loop lines', () => {
    expect(thresholds(F.stableLoop, (p) => directionScenario(dir('USD'), -p))).toEqual({ WATCH: 0, NEAR: null, LIQ: null }); // already Watch; all-stables never moves it further
    const t = thresholds(F.stableLoop, (p) => directionScenario(dir('USDE'), -p));
    // hf 10,000 × 0.9 / 8,400 = 1.071 — already under the loop's warn line (1.08), Near (< 1.03) at −4%, liquidatable at −7%
    expect(t).toEqual({ WATCH: 0, NEAR: 4, LIQ: 7 });
  });
});

describe('scenario engine — Nado', () => {
  it('unhedged long: down hurts, up does not', () => {
    const d = thresholds(F.unhedgedLong, down('BTC'));
    expect(d.LIQ).not.toBeNull();
    expect(d.WATCH! <= d.NEAR! && d.NEAR! <= d.LIQ!).toBe(true);
    expect(thresholds(F.unhedgedLong, up('BTC'))).toEqual({ WATCH: null, NEAR: null, LIQ: null });
  });
  it('unhedged short: up hurts, down does not', () => {
    expect(thresholds(F.unhedgedShort, up('BTC')).LIQ).not.toBeNull();
    expect(thresholds(F.unhedgedShort, down('BTC'))).toEqual({ WATCH: null, NEAR: null, LIQ: null });
  });
  it('high leverage breaks on a smaller move than lower leverage', () => {
    expect(thresholds(F.levered, down('ETH')).LIQ!).toBeLessThan(thresholds(F.unhedgedLong, down('BTC')).LIQ!);
  });
  it('hedged (kBTC spot vs BTC short): stays safe even 50% down or up', () => {
    expect(thresholds(F.hedged, down('BTC'))).toEqual({ WATCH: null, NEAR: null, LIQ: null });
    expect(thresholds(F.hedged, up('BTC'))).toEqual({ WATCH: null, NEAR: null, LIQ: null });
  });
  it('isolated margin is liquidated on its own: the small isolated subaccount dies while the big main one is fine', () => {
    const t = thresholds(F.isolated, down('ETH'));
    expect(t.LIQ).not.toBeNull();
    expect(t.LIQ!).toBeLessThan(15);
  });
  it('stocks as collateral: a stock drop alone endangers it (buffer 14% now → under 10% at about −5%), crypto moves do nothing', () => {
    expect(thresholds(F.stocks, down('XSTOCK')).NEAR).toBe(5);
    expect(thresholds(F.stocks, down('CRYPTO'))).toEqual({ WATCH: 0, NEAR: null, LIQ: null });
  });
  it("Nado's own unit of account (USDT0 on Nado) never moves there", () => {
    const b = shockBook(F.unhedgedLong, directionScenario(dir('USD'), -30));
    expect(stressState(b)).toEqual(stressState(F.unhedgedLong));
  });
});

describe('scenario engine — what it refuses to fake', () => {
  it('missing price → unsupported', () => expect(confidenceOf(F.missingPrice).confidence).toBe('UNSUPPORTED'));
  it("half unreadable → unsupported", () => expect(confidenceOf(F.partial).confidence).toBe('UNSUPPORTED'));
  it('mixed Tydro collateral is marked approximate; one collateral is modelled', () => {
    expect(confidenceOf(F.tydroBorrower).confidence).toBe('MODELLED');
    const mixed = mk({ tydro: { supplies: [['WETH', 5_000], ['kBTC', 5_000]], debts: [['USDC', 4_000]] }, nado: {} });
    expect(confidenceOf(mixed).confidence).toBe('APPROXIMATE');
  });
  it('empty and debt-free wallets cannot be liquidated by price', () => {
    expect(canBeLiquidated(F.empty)).toBe(false);
    expect(canBeLiquidated(mk({ tydro: { supplies: [['WETH', 5_000]] }, nado: {} }))).toBe(false);
    expect(thresholds(F.empty, down('CRYPTO'))).toEqual({ WATCH: null, NEAR: null, LIQ: null });
  });
  it('every direction builds a scenario; depeg directions only go down', () => {
    for (const d of DIRECTIONS) expect(Object.keys(directionScenario(d, -10)).length).toBeGreaterThan(0);
    expect(DIRECTIONS.filter((d) => d.downOnly).map((d) => d.id)).toEqual(['USD', 'USDE', 'USDC']);
  });
});
