// Generates /fixtures/*.json — the six dossier examples as normalized Books.
// Run: node scripts/make-fixtures.mjs
// Addresses are synthetic (0x…ae60XX) and belong to nobody.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'fixtures');
mkdirSync(out, { recursive: true });

const T0 = Date.parse('2026-09-28T00:00:00Z');
const addr = (n) => `0x${'0'.repeat(34)}ae60${String(n).padStart(2, '0')}`;
const SUB = (a) => `${a}64656661756c740000000000`; // + "default"

const leg = (symbol, family, assetClass, amount, price, src = 'FIXTURE') => ({
  symbol, family, assetClass, amount, usd: amount * price, priceUsd: price, priceSource: src,
});
const spot = (a, productId, ...args) => ({ ...leg(...args), productId, subaccount: SUB(a) });
const perp = (a, productId, symbol, family, assetClass, sizeBase, price, entry) => {
  const vQuoteUsd = -sizeBase * entry;
  return {
    productId, subaccount: SUB(a), symbol, family, assetClass, sizeBase,
    notionalUsd: sizeBase * price, priceUsd: price, priceSource: 'FIXTURE',
    vQuoteUsd, unsettledUsd: vQuoteUsd + sizeBase * price,
  };
};
const ok = (data) => ({ status: 'OK', data, asOfTime: T0, asOfBlock: null });
const tydro = (supplies, debts, hf, lt = 0.7) => {
  const c = supplies.reduce((s, x) => s + x.usd, 0);
  const d = debts.reduce((s, x) => s + x.usd, 0);
  return ok({ hf, supplies, debts, totalCollateralUsd: c, totalDebtUsd: d, usdNet: c - d, liquidationThreshold: supplies.length ? lt : null, notes: [] });
};
const nado = (a, spots, perps, maint) => {
  const equity = spots.reduce((s, x) => s + x.usd, 0) + perps.reduce((s, x) => s + x.unsettledUsd, 0);
  return ok({
    subaccounts: spots.length || perps.length ? [SUB(a)] : [],
    equityUsd: equity,
    spots, perps,
    maintenance: maint ?? null,
    initial: null,
    unweighted: maint ? { assetsUsd: equity, liabilitiesUsd: 0, healthUsd: equity } : null,
    funding: perps.map((p) => ({ symbol: p.symbol, side: p.sizeBase > 0 ? 'LONG' : 'SHORT', rateHourly: null })),
    notes: [],
  });
};
const book = (n, label, t, nd) => ({ address: addr(n), source: 'FIXTURE', label, tydro: t, nado: nd, asOfBlock: null, asOfTime: T0 });

const BTC = 100_000;
const ETH = 4_000;

// EX1 CARRY — kBTC spot $10k, BTC short perp $10k, hf 2.1
const a1 = addr(1);
const ex1 = book(1, 'EX1 CARRY',
  tydro([leg('WETH', 'ETH', 'CRYPTO', 0.75, ETH)], [leg('USDC', 'USD', 'STABLE', 1000, 1)], 2.1),
  nado(a1, [spot(a1, 1, 'KBTC', 'BTC', 'CRYPTO', 0.1, BTC)], [perp(a1, 2, 'BTC-PERP', 'BTC', 'CRYPTO', -0.1, BTC, BTC)],
    { assetsUsd: 9700, liabilitiesUsd: 300, healthUsd: 9400 }),
);

// EX2 NAKED — BTC long perp $10k, USDT0 collateral $3k
const a2 = addr(2);
const ex2 = book(2, 'EX2 NAKED',
  tydro([], [], null),
  nado(a2, [spot(a2, 0, 'USDT0', 'USD', 'STABLE', 3000, 1)], [perp(a2, 2, 'BTC-PERP', 'BTC', 'CRYPTO', 0.1, BTC, BTC)],
    { assetsUsd: 3000, liabilitiesUsd: 100, healthUsd: 2900 }),
);

// EX3 EQUITY-MARGIN — SPYx collateral $8k, ETH long perp $5k
const a3 = addr(3);
const ex3 = book(3, 'EX3 EQUITY-MARGIN',
  tydro([], [], null),
  nado(a3, [spot(a3, 117, 'wSPYx', 'SPY', 'XSTOCK', 10, 800)], [perp(a3, 4, 'ETH-PERP', 'ETH', 'CRYPTO', 1.25, ETH, ETH)],
    { assetsUsd: 7200, liabilitiesUsd: 50, healthUsd: 7150 }),
);

// EX4 WOUNDED CARRY — EX1 but hf 1.12
const a4 = addr(4);
const ex4 = book(4, 'EX4 WOUNDED CARRY',
  tydro([leg('WETH', 'ETH', 'CRYPTO', 0.75, ETH)], [leg('USDC', 'USD', 'STABLE', 1875, 1)], 1.12),
  nado(a4, [spot(a4, 1, 'KBTC', 'BTC', 'CRYPTO', 0.1, BTC)], [perp(a4, 2, 'BTC-PERP', 'BTC', 'CRYPTO', -0.1, BTC, BTC)],
    { assetsUsd: 9700, liabilitiesUsd: 300, healthUsd: 9400 }),
);

// EX5 DARK — Nado fetch failed, Tydro OK
const ex5 = book(5, 'EX5 DARK',
  tydro([leg('WETH', 'ETH', 'CRYPTO', 0.75, ETH)], [leg('USDC', 'USD', 'STABLE', 1000, 1)], 2.1),
  { status: 'DARK', code: 'VENUE_TIMEOUT', message: 'Nado gateway did not answer within 8s (fixture)', asOfTime: T0 },
);

// EX6 EMPTY — zero positions
const a6 = addr(6);
const ex6 = book(6, 'EX6 EMPTY', tydro([], [], null), nado(a6, [], [], null));

const files = {
  'carry.json': ex1,
  'naked.json': ex2,
  'equity-margin.json': ex3,
  'wounded.json': ex4,
  'dark.json': ex5,
  'empty.json': ex6,
};
for (const [f, b] of Object.entries(files)) writeFileSync(join(out, f), JSON.stringify(b, null, 2) + '\n');
console.log('wrote', Object.keys(files).join(', '));
