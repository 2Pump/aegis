import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

test('home boots gated: no well, no fixture stars, read-only footer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('unverified-banner')).toBeVisible();
  await expect(page.getByTestId('well-canvas')).toHaveCount(0);
  await expect(page.getByText('EX1 CARRY')).toHaveCount(0);
  await expect(page.getByTestId('footer')).toContainText('Phrourax is read-only. It never connects to your wallet and cannot move funds. Classifications may be incomplete or incorrect. Not financial advice.');
  await expect(page.getByTestId('footer')).toContainText('chain 57073');
  await expect(page.getByTestId('footer-x')).toHaveAttribute('href', 'https://x.com/Phrourax');
});

test('paste empty / junk address → error, no navigation', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('paste-go').click();
  await expect(page.getByTestId('paste-error')).toBeVisible();
  await page.getByTestId('paste-input').fill('0x1234');
  await page.getByTestId('paste-go').click();
  await expect(page.getByTestId('paste-error')).toContainText('Not a 0x address');
  await expect(page).toHaveURL(/\/$/);
});

test('fixture CARRY renders plate with reasons', async ({ page }) => {
  await page.goto('/fixture/carry');
  await expect(page.getByTestId('fixture-banner')).toBeVisible();
  await expect(page.getByTestId('primary-tag')).toHaveText('Hedged');
  await expect(page.getByTestId('hull-temp')).toContainText('SAFE');
  await expect(page.getByTestId('reasons')).toContainText('CARRY · BTC');
});

test('fixture WOUNDED is CRITICAL; fixture DARK renders without crashing', async ({ page }) => {
  await page.goto('/fixture/wounded');
  await expect(page.getByTestId('hull-temp')).toContainText('NEAR LIQUIDATION');
  await page.goto('/fixture/dark');
  await expect(page.getByTestId('primary-tag')).toHaveText("Couldn't read");
  await expect(page.getByTestId('dark-reasons')).toContainText("Nado couldn't be read");
  await expect(page.getByTestId('sensor-dark')).toBeVisible();
});

test('paste a real-format address → hull page renders (DARK if sensors unreachable, never blank)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('paste-input').fill('0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560');
  await page.getByTestId('paste-go').click();
  await expect(page).toHaveURL(/\/hull\/0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560$/);
  await expect(page.getByTestId('hull-plate')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('primary-tag')).toBeVisible();
  await expect(page.getByTestId('sensor-log')).toContainText(/TYDRO|NADO/);
});

test('rules live in one drawer: the button opens it, old /rules links open it, Escape closes it', async ({ page }) => {
  await page.goto('/fixture/carry');
  await page.getByTestId('rules-drawer-btn').click();
  await expect(page.getByTestId('rules-drawer')).toContainText('WOUNDED_HF');
  await expect(page.getByTestId('display-names')).toContainText('Unhedged bet');
  await expect(page).toHaveURL(/\/fixture\/carry\?rules=1$/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('rules-drawer')).toHaveCount(0);
  await page.getByText('read rules').click();
  await expect(page.getByTestId('rules-drawer')).toContainText('CARRY_BAND');
  await page.goto('/rules');
  await expect(page).toHaveURL(/\/\?rules=1$/);
  await expect(page.getByTestId('rules-drawer')).toContainText('CARRY_BAND');
  await expect(page.getByRole('link', { name: 'Rules', exact: true })).toHaveCount(0);
});

test('calibration page lists fixtures and shows not-yet-checked status', async ({ page }) => {
  await page.goto('/calibration');
  await expect(page.getByTestId('proof-panel')).toContainText('NOT YET CHECKED');
  await expect(page.getByTestId('fixture-list')).toContainText('EX1 CARRY');
});

test('live hull plate carries the unverified banner', async ({ page }) => {
  await page.goto('/hull/0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560');
  await expect(page.getByTestId('unverified-plate')).toBeVisible({ timeout: 30_000 });
});

test('"My wallet" is remembered from a wallet page — and no wallet extension is ever asked for anything', async ({ page }) => {
  // a fake injected wallet that records every request the site makes to it
  await page.addInitScript(() => {
    (window as unknown as { __walletCalls: string[] }).__walletCalls = [];
    (window as unknown as { ethereum: unknown }).ethereum = {
      isMetaMask: true,
      request: async (a: { method: string }) => {
        (window as unknown as { __walletCalls: string[] }).__walletCalls.push(a.method);
        return [];
      },
      on() {},
      removeListener() {},
    };
  });
  const addr = '0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560';
  await page.goto('/');
  await expect(page.getByTestId('my-wallet')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /open my wallet|connect/i })).toHaveCount(0);
  await page.goto(`/hull/${addr}`);
  await page.getByTestId('my-wallet-toggle').click({ timeout: 30_000 });
  await expect(page.getByTestId('my-wallet')).toContainText('0x8d7d');
  await page.goto('/');
  await page.getByTestId('my-wallet').click();
  await expect(page).toHaveURL(new RegExp(`/hull/${addr}$`));
  await page.getByTestId('my-wallet-toggle').click({ timeout: 30_000 });
  await expect(page.getByTestId('my-wallet')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __walletCalls: string[] }).__walletCalls)).toEqual([]);
});

test('wallet plate: one line per type that fired, the dot on the main type, risk on the rail, no dollar amounts', async ({ page }) => {
  // EX1 CARRY = Hedged (main) + Bitcoin-backed
  await page.goto('/fixture/carry');
  const plate = page.getByTestId('wallet-plate');
  await expect(plate.locator('[data-testid="plate-main-level"], [data-testid="plate-level"]')).toHaveCount(2);
  await expect(page.getByTestId('plate-main-level')).toHaveAttribute('data-tag', 'CARRY');
  await expect(page.getByTestId('plate-main-level').locator('.plate-dot')).toHaveCount(1);
  await expect(page.getByTestId('plate-level')).toHaveAttribute('data-tag', 'KBTC-CORE');
  await expect(page.getByTestId('plate-level').locator('.plate-dot')).toHaveCount(0);
  await expect(page.getByTestId('plate-risk-dot')).toHaveAttribute('data-stop', 'NOMINAL');
  expect(await plate.innerText()).not.toMatch(/\$|health factor|\bhf\b/i);
  for (const t of ['Wallet', 'Risk', 'Position type — why', 'Tydro lending', 'Nado account', 'Exposure', 'Share']) {
    await expect(page.locator('h3.panel-title', { hasText: t }).first()).toBeVisible();
  }
  // near liquidation: the dot sits at the top of the rail, and only there is red
  await page.goto('/fixture/wounded');
  await expect(page.getByTestId('plate-risk-dot')).toHaveAttribute('data-stop', 'CRITICAL');
  await expect(page.locator('.plate-stop.red')).toHaveCount(1);
  // couldn't read: no made-up levels, the hollow mark is lit
  await page.goto('/fixture/dark');
  await expect(page.getByTestId('primary-tag')).toHaveText("Couldn't read");
  await expect(page.locator('.plate-level')).toHaveCount(0);
  // empty: no levels, the rail at SAFE
  await page.goto('/fixture/empty');
  await expect(page.getByTestId('primary-tag')).toHaveText('Empty');
  await expect(page.locator('.plate-level')).toHaveCount(0);
  await expect(page.getByTestId('plate-risk-dot')).toHaveAttribute('data-stop', 'NOMINAL');
  await expect(page.getByTestId('fixture-banner')).toBeVisible();
});

test('Pressure Map: in the nav after Well (then Intel); locked with the well until verified (no numbers shown)', async ({ page }) => {
  await page.goto('/');
  const links = await page.locator('nav.nav a').allInnerTexts();
  expect(links.map((l) => l.trim().toUpperCase()).slice(0, 4)).toEqual(['WELL', 'PRESSURE', 'INTEL', 'SCAN']);
  await page.getByRole('link', { name: 'Pressure' }).click();
  await expect(page).toHaveURL(/\/pressure$/);
  await expect(page.getByTestId('pressure-locked')).toBeVisible();
  await expect(page.locator('footer, .footer').first()).toContainText('Phrourax is read-only. It never connects to your wallet and cannot move funds. Classifications may be incomplete or incorrect. Not financial advice.');
});

test('stress test on a wallet page: thresholds per direction, a custom scenario, no network, nothing to stress when nothing can be liquidated', async ({ page }) => {
  await page.goto('/fixture/naked');
  const st = page.getByTestId('stress-test');
  await expect(st).toBeVisible();
  await expect(page.getByTestId('stress-lead')).toContainText(/approximately \d+% BTC decline/);
  await expect(page.getByTestId('stress-rows').locator('tbody tr').first()).toContainText('BTC falls');
  await st.locator('select').selectOption('BTC');
  await st.locator('input[type="number"]').fill('-40');
  await expect(page.getByTestId('stress-custom')).toHaveText(/liquidatable/i);
  await page.goto('/fixture/empty');
  await expect(page.getByTestId('stress-none')).toBeVisible();
  await page.goto('/fixture/dark');
  await expect(page.getByTestId('stress-confidence')).toContainText("can't simulate");
});

test('Alerts: in the nav marked SOON (still clickable), coming-soon banner, no sign-up form, no bot link, privacy stated', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByTestId('nav-alerts');
  await expect(nav).toHaveAccessibleName('Alerts, coming soon');
  await expect(nav).toContainText('SOON');
  await nav.click();
  await expect(page).toHaveURL(/\/watch$/);
  await expect(page.getByTestId('alerts-unavailable')).toContainText('COMING SOON · BUILT AND TESTED');
  await expect(page.getByTestId('alerts-unavailable')).toContainText('not accepting sign-ups yet');
  await expect(page.getByText('NOT LIVE YET')).toHaveCount(0);
  await expect(page.getByTestId('alerts-page')).toHaveAttribute('data-live', 'no');
  await expect(page.locator('input, form, a[href*="t.me"]')).toHaveCount(0);
  await expect(page.locator('dt', { hasText: '/delete' })).toBeVisible();
  await expect(page.getByText(/never balances or position sizes/)).toBeVisible();
});

test('Checks: versions in force are stated; the automatic-checks panel says when nothing has run (never a pass)', async ({ page }) => {
  await page.goto('/calibration');
  await expect(page.getByTestId('versions-now')).toContainText('scenario engine');
  const auto = page.getByTestId('auto-checks');
  await expect(auto).toBeVisible();
  await expect(auto.getByText(/No automatic check has run yet|Couldn't load the check log/)).toBeVisible();
  await expect(auto.getByText('CURRENT', { exact: true })).toHaveCount(0);
});

test('INTEL: in the nav between Pressure and Scan; every section is built and none invents data', async ({ page }) => {
  await page.goto('/');
  const links = await page.locator('nav[aria-label="Primary"] a').allTextContents();
  // the Alerts item may carry its SOON badge; the order is what's checked here
  expect(links.map((s) => s.trim().toUpperCase().replace(/SOON$/, ''))).toEqual(['WELL', 'PRESSURE', 'INTEL', 'SCAN', 'ALERTS', 'CHECKS']);
  await page.goto('/intel');
  await expect(page.getByTestId('intel-tabs')).toBeVisible();
  // built in Release 4: analysis only, and with nothing recorded it says so
  await page.getByTestId('intel-tab-carry').click();
  await expect(page.getByTestId('carry-disclaimer')).toContainText('ANALYSIS ONLY');
  await expect(page.getByTestId('intel-carry').getByText(/NOT RECORDING YET|Couldn't load/).first()).toBeVisible();
  // built in Release 3: with nothing recorded they say so — never a table of made-up prices
  await page.getByTestId('intel-tab-oracles').click();
  await expect(page.getByTestId('intel-oracles').getByText(/NOT RECORDING YET|Couldn't load/).first()).toBeVisible();
  await expect(page.getByTestId('oracles-table')).toHaveCount(0);
  await page.getByTestId('intel-tab-changes').click();
  await expect(page.getByTestId('intel-changes').getByText(/NOT MONITORING YET|Couldn't load/).first()).toBeVisible();
  await expect(page.getByTestId('intel-not-built')).toHaveCount(0);
  // the Liquidation Ledger is built; in a locked build it is locked with the well (no numbers)
  await page.getByTestId('intel-tab-liquidations').click();
  await expect(page.getByText(/Locked with the well|NOT RECORDING YET|Liquidation ledger/).first()).toBeVisible();
  await expect(page.getByTestId('intel-not-built')).toHaveCount(0);
});

/* Release 3 with recorded (synthetic) files served in place of the census store */
const R3 = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
/** the recorded-prices fixture moved so its last point is an hour ago (the 7-day chart must not depend on today's date) */
function recentPrices(): string {
  const f = JSON.parse(R3('prices.json')) as { month: string; points: Array<{ at: number }> };
  const shift = Date.now() - 3_600_000 - Math.max(...f.points.map((p) => p.at));
  return JSON.stringify({ ...f, month: new Date().toISOString().slice(0, 7), points: f.points.map((p) => ({ ...p, at: p.at + shift })) });
}
async function serveRelease3(page: Page) {
  const month = new Date().toISOString().slice(0, 7);
  const json = (body: string) => ({ status: 200, contentType: 'application/json', body });
  await page.route('**/api/v1/data/history/**', (route) => {
    const u = new URL(route.request().url()).pathname;
    if (u.endsWith('/history/index.json')) return route.fulfill(json(JSON.stringify({ v: 1, kind: 'aegis-history-index', version: 'hist-1.0.0', shards: 64, months: [], baselined: [], compacted: [], firstAt: null, firstBlock: null, changeMonths: [month] })));
    if (u.endsWith('/history/oracle/latest.json')) return route.fulfill(json(R3('oracle-latest.json')));
    if (u.endsWith(`/history/prices/${month}.json`)) return route.fulfill(json(recentPrices()));
    if (u.endsWith('/history/params/latest.json')) return route.fulfill(json(R3('params-latest.json')));
    if (u.endsWith(`/history/changes/${month}.json`)) return route.fulfill(json(R3('changes.json')));
    if (u.endsWith('/history/forecast-score.json')) return route.fulfill(json(R3('forecast-score.json')));
    if (u.endsWith('/history/carry/latest.json')) return route.fulfill(json(R3('carry-latest.json')));
    return route.fulfill({ status: 404, body: '' });
  });
}

test('ORACLES: every asset with its status; a depeg is an event; details show checks and modelled impact', async ({ page }) => {
  await serveRelease3(page);
  await page.goto('/intel?tab=oracles');
  const t = page.getByTestId('oracles-table');
  await expect(t).toBeVisible();
  await expect(page.getByTestId('oracle-row-USDe')).toContainText('DEPEG');
  await expect(page.getByTestId('oracles-events')).toContainText('USDe');
  await page.getByTestId('oracle-row-USDe').getByRole('button').click();
  // the modelled impact (wallet counts) shows only when the well is on; otherwise it says it is locked
  await expect(page.getByText(/Approximate — not a prediction|locked with the well until the readings are verified \(no counts shown\)/).first()).toBeVisible();
  await expect(page.getByTestId('oracles-history').locator('svg')).toBeVisible();
  // a reference that isn't compared shows its last price as history, never as a current price
  await page.getByTestId('oracle-row-kBTC').getByRole('button').click();
  await expect(page.getByTestId('oracle-ext-stale-kBTC')).toContainText('stale — not a current price');
  await expect(page.getByText(/guaranteed|AI-powered/i)).toHaveCount(0);
});

test('CHANGES: old → new between two blocks, transaction candidates, before/after labelled not isolated', async ({ page }) => {
  await serveRelease3(page);
  await page.goto('/intel?tab=changes');
  const list = page.getByTestId('changes-list');
  await expect(list).toBeVisible();
  await expect(list).toContainText('8300');
  await expect(list).toContainText('8250');
  await expect(list).toContainText(/not isolated|locked with the well/);
  await expect(list.locator('a[href*="/tx/"]')).toHaveCount(1);
  await page.getByTestId('changes-filter').fill('implementation');
  await expect(page.getByTestId('changes-params')).toContainText('Pool implementation');
});

test('Checks: Pressure forecasts are scored only where prices were recorded', async ({ page }) => {
  await serveRelease3(page);
  await page.goto('/calibration');
  const f = page.getByTestId('forecast-track');
  await expect(f).toBeVisible();
  await expect(f.getByTestId('forecast-table')).toBeVisible();
  await expect(f).toContainText(/neither hits nor misses/);
});

test('CARRY: estimated net per structure, every leg and risk factor, nothing to act with, no promised-return language', async ({ page }) => {
  await serveRelease3(page);
  await page.goto('/intel?tab=carry');
  await expect(page.getByTestId('carry-table-cash-and-carry')).toBeVisible();
  const row = page.getByTestId('carry-row-cc-nado-3-4');
  await expect(row).toContainText('%');
  await row.getByRole('button').click();
  const d = page.getByTestId('carry-detail-cc-nado-3-4');
  await expect(d).toContainText('ETH-PERP funding received by a short');
  await expect(d).toContainText('funding-reversal');
  await expect(d).toContainText('Nado trading fee');
  await expect(d).toContainText(/liquidated only if/);
  await expect(page.getByTestId('carry-funding')).toBeVisible();
  // no execution path: no links out of Phrourax and no buttons other than expand / show-more / tabs / nav
  const main = page.locator('main, .stack').first();
  await expect(main.getByText(/guarantee|risk[- ]free|\bAPY\b/i)).toHaveCount(0);
  const buttons = await page.getByTestId('intel-carry').getByRole('button').allTextContents();
  for (const b of buttons) expect(b).not.toMatch(/buy|sell|borrow now|trade|deposit now|connect|approve|open position/i);
  await expect(page.getByTestId('intel-carry').locator('a[href^="http"]')).toHaveCount(0);
});

test('Developers: the public API is documented (read-only, no wallet listing) and webhooks say NOT LIVE', async ({ page }) => {
  await page.goto('/developers');
  const d = page.getByTestId('developers-page');
  await expect(d).toContainText('/api/v1');
  await expect(d).toContainText('/wallets/{address}');
  await expect(d.locator('a[href="/api/v1/openapi.json"]')).toHaveCount(1);
  await expect(page.getByTestId('webhooks-not-live')).toContainText('NOT LIVE YET');
  await expect(page.getByTestId('dev-example')).toContainText('"schema": "phrourax-api-1"');
  await expect(page.locator('body')).not.toContainText('aegis');
  await expect(d.getByText(/ranks? them by closeness to liquidation/i).first()).toBeVisible(); // stated as something it never does
  await page.goto('/watch');
  await expect(page.getByTestId('alerts-page')).toContainText('actually liquidated');
});

test('wallet page: a HISTORY section that never invents history (no recording → says so)', async ({ page }) => {
  await page.goto('/hull/0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560');
  const h = page.getByTestId('wallet-history');
  await expect(h).toBeVisible({ timeout: 30_000 });
  await expect(h.getByText(/NOT RECORDING YET|couldn't be loaded|Recorded live by the hourly scan since/)).toBeVisible();
  await expect(h.getByTestId('history-past')).toBeVisible();
  await expect(h.getByTestId('history-not-recorded')).toBeVisible();
});

test('test wallets never get a history section', async ({ page }) => {
  await page.goto('/fixture/carry');
  await expect(page.getByTestId('wallet-history')).toHaveCount(0);
});

test('Checks: the track record never shows a rate it cannot back (not scored yet → says so)', async ({ page }) => {
  await page.goto('/calibration');
  const t = page.getByTestId('track-record');
  await expect(t).toBeVisible();
  await expect(t.getByText(/NOT SCORED YET|Couldn't load|Total liquidation records/).first()).toBeVisible();
  await expect(t.getByText(/AI|guaranteed/i)).toHaveCount(0);
});

/* ───────── refinement pass (2026-10-05) ───────── */

const rate = (num: number, den: number) => ({ num, den, rate: den ? num / den : null, lowSample: den < 30 });
/** report files as each scoring method wrote them (old ones must stay readable) */
function accountability(version: string, over: Record<string, unknown> = {}) {
  const legacyWin = (hours: number) => ({ hours, precision: rate(0, 0), pending: 0, leadAtLeast: rate(0, 32) });
  const curWin: Record<number, unknown> = {
    1: { hours: 1, precision: rate(1, 3), pending: 0, leadAtLeast: rate(10, 25), insufficientHistory: 7 },
    6: { hours: 6, precision: rate(1, 3), pending: 0, leadAtLeast: rate(4, 20), insufficientHistory: 12 },
    24: { hours: 24, precision: rate(0, 0), pending: 3, leadAtLeast: rate(0, 6), insufficientHistory: 26 },
    168: { hours: 168, precision: rate(0, 0), pending: 3, leadAtLeast: rate(0, 0), insufficientHistory: 32 },
  };
  const current = version === 'acct-1.2.0';
  return {
    v: 1,
    kind: 'aegis-accountability',
    version,
    generatedAt: new Date().toISOString(),
    recordingStart: '2026-10-04T00:00:00Z',
    definitions: { warning: 'x' },
    liquidations: { total: 139, evaluable: 32, beforeRecording: 107, notSeen: 2, partial: 137 },
    warnings: { total: 59865, atRecordingStart: 59865, ...(version !== 'acct-1.0.0' ? { afterRecordingStart: current ? 3 : 0 } : {}) },
    ...(current
      ? {
          baseline: { uniqueWallets: 2612, rows: 2612, firstAt: '2026-10-04T00:05:00Z', repeatedRows: 57253, repeatedRuns: 22 },
          transitions: { reliableSince: '2026-10-05T02:05:00Z', counted: 3, excluded: 0, available: true },
        }
      : {}),
    recall: rate(1, 32),
    watchOnly: rate(0, 32),
    missed: rate(31, 32),
    leadHoursMedian: null,
    windows: [1, 6, 24, 168].map((h) => (current ? curWin[h] : legacyWin(h))),
    byVenue: [{ key: 'tydro', recall: rate(1, 32), precision24: rate(0, 0) }],
    bySize: [],
    byType: [],
    byFamily: [],
    byRules: [],
    limitations: ['x'],
    ...over,
  };
}
async function serveAccountability(page: Page, body: unknown) {
  await page.route('**/api/v1/data/history/**', (route) => {
    const u = new URL(route.request().url()).pathname;
    if (u.endsWith('/history/accountability.json')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    return route.fulfill({ status: 404, body: '' });
  });
}

test('Track record (current method): one version label, windows with their own eligible denominators, unique-wallet baseline', async ({ page }) => {
  await serveAccountability(page, accountability('acct-1.2.0'));
  await page.goto('/calibration');
  const t = page.getByTestId('track-record');
  await expect(t.getByTestId('track-version')).toHaveText('scoring method acct-1.2.0');
  await expect(t.getByText('scoring method acct-1.2.0.')).toBeVisible();
  await expect(t.getByTestId('track-method-note')).toHaveCount(0);
  await expect(t.getByText(/acct-1\.[01]\.0/)).toHaveCount(0);
  // baseline: unique wallets, repeats explained, never scored
  await expect(t.getByText('Unique wallets already NEAR LIQUIDATION at recording start')).toBeVisible();
  await expect(t.getByTestId('track-baseline')).toContainText('2,612');
  await expect(t.getByTestId('track-baseline-explain')).toContainText('57,253 baseline rows');
  await expect(t.getByTestId('track-baseline-explain')).toContainText('WATCH is not included');
  await expect(t.getByTestId('track-new-warnings')).toContainText('3');
  // looking back: each window its own denominator; 7 days → not enough history; never "0 of 32 (0%)"
  const back = t.getByTestId('track-lookback');
  await expect(back.locator('tr', { hasText: '7 days' })).toContainText('Not enough recording history');
  await expect(back.locator('tr', { hasText: '7 days' })).toContainText('32');
  await expect(back.locator('tr', { hasText: '1 h' })).toContainText('10 of 25 eligible liquidations');
  await expect(back.locator('tr', { hasText: '24 h' })).toContainText('0 of 6 eligible liquidations');
  await expect(back).not.toContainText('0 of 32'); // the lookback never uses all 32 when only some had a complete lookback
  await expect(back).not.toContainText('(0%)');
  // "any time before" figures span everything since recording began — a complete window — so a zero there is genuine
  await expect(t.getByText('0 of 32 (0%)')).toBeVisible();
  // looking forward: judged vs awaiting outcome; no percentage on a tiny sample
  const fwd = t.getByTestId('track-windows');
  await expect(fwd.locator('tr', { hasText: '1 h' })).toContainText('1 of 3 judged warnings · too few cases to judge');
  await expect(fwd.locator('tr', { hasText: '7 days' })).toContainText('No warnings have completed this window yet');
  await expect(fwd).not.toContainText('%');
  await expect(t.getByTestId('track-early')).toContainText('EARLY RECORDING PERIOD — performance statistics are not yet representative.');
  // separate liquidation rows stay
  const liq = t.getByTestId('track-liquidations');
  for (const k of ['Total liquidation records', 'Before Phrourax recording began', 'Evaluable since recording began', 'Records with one or more unavailable fields']) await expect(liq.locator('dt', { hasText: k })).toBeVisible();
  await expect(t).not.toContainText(/success rate|accuracy|predicted/i);
});

test('Track record (report from an older method): its own version shown and explained; changed figures await rescoring; still readable', async ({ page }) => {
  for (const v of ['acct-1.0.0', 'acct-1.1.0']) {
    await serveAccountability(page, accountability(v));
    await page.goto('/calibration');
    const t = page.getByTestId('track-record');
    await expect(t.getByTestId('track-version')).toHaveText(`scoring method ${v}`);
    await expect(t.getByTestId('track-method-note')).toContainText(`This report was produced under scoring method ${v}. The site now uses acct-1.2.0`);
    await expect(t.getByText('Baseline rows imported (not a wallet count)')).toBeVisible();
    await expect(t.getByTestId('track-baseline')).toContainText('59,865');
    await expect(t.getByTestId('track-new-warnings')).toContainText('New warning transitions not available yet');
    await expect(t.getByTestId('track-lookback')).toContainText('awaiting rescoring');
    await expect(t.getByTestId('track-windows')).toContainText('Awaiting rescoring under acct-1.2.0');
    await expect(t).not.toContainText('0 of 32 eligible');
    await expect(t.getByTestId('track-lookback')).not.toContainText('0 of 32');
    await expect(t.getByText('1 of 32').first()).toBeVisible(); // figures defined the same way under every method stay
    await page.unroute('**/api/v1/data/history/**');
  }
});

test('Track record: right after a repeated baseline import, new warnings say "not available yet" — never a false zero', async ({ page }) => {
  await serveAccountability(page, accountability('acct-1.2.0', { transitions: { reliableSince: new Date().toISOString(), counted: 0, excluded: 0, available: false }, warnings: { total: 59865, atRecordingStart: 59865, afterRecordingStart: 0 } }));
  await page.goto('/calibration');
  const t = page.getByTestId('track-record');
  await expect(t.getByTestId('track-new-warnings')).toHaveText('New warning transitions not available yet');
  await expect(t.getByTestId('track-windows')).toContainText('New warning transitions not available yet');
});

test('Legacy AEGIS wording inside stored files is shown as PHROURAX on every page that reads them', async ({ page }) => {
  await serveRelease3(page);
  for (const path of ['/intel?tab=changes', '/intel?tab=carry', '/intel?tab=oracles', '/calibration']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).not.toContainText('AEGIS');
    await expect(page.locator('body')).not.toContainText('Aegis');
  }
});

test('Homepage: the value sentence under the address field; the address field stays first', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('home-sub')).toHaveText(
    'Paste an Ink wallet to see its position type, liquidation risk, cross-venue exposure, and response to simulated market moves. Read-only. No wallet connection required.',
  );
  await expect(page.getByTestId('paste-input')).toBeVisible();
});

test('Share: post text in short lines, Post on X / Copy text / Copy link / Download card, link via /s/, never amounts', async ({ page }) => {
  const addr = '0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560';
  const checksum = '0x8D7d64d6cF1D4F018Dd101482Ac71Ad49e30c560';
  await page.goto(`/hull/${addr}`);
  const p = page.getByTestId('share-panel');
  await expect(p).toBeVisible({ timeout: 30_000 });
  const text = (await p.getByTestId('share-text').textContent()) ?? '';
  const lines = text.split('\n');
  expect(lines[0]).toBe(`Phrourax · Ink wallet ${checksum.slice(0, 6)}…${checksum.slice(-4)}`);
  expect(lines[1]).toMatch(/^Position: /);
  expect(lines[2]).toMatch(/^Risk: /);
  expect(lines[3]).toBe(`https://phrourax.com/s/${checksum}`);
  expect(text).not.toMatch(/\$|health factor|HF /i);
  const x = p.getByTestId('share-x');
  const href = (await x.getAttribute('href')) ?? '';
  expect(href).toMatch(/^https:\/\/x\.com\/intent\/tweet\?text=/);
  expect(decodeURIComponent(href)).toContain(`url=https://phrourax.com/s/${checksum}`);
  expect(href).toContain('&via=Phrourax');
  expect(await x.getAttribute('target')).toBe('_blank');
  await expect(p.getByTestId('share-copy-text')).toBeEnabled();
  await expect(p.getByTestId('share-copy-link')).toBeEnabled();
  // the card only exists where the share function runs (not on a local build): the panel hides it rather than show a broken image
  await expect(p.getByTestId('share-card')).toHaveCount(0);
});

test('Share on a test wallet: text only — no card, no link, nothing to post', async ({ page }) => {
  await page.goto('/fixture/carry');
  const p = page.getByTestId('share-panel');
  await expect(p).toBeVisible();
  await expect(p.getByTestId('share-text')).toContainText('Position: Hedged');
  await expect(p.getByTestId('share-text')).not.toContainText('phrourax.com/s/');
  await expect(p.getByTestId('share-card')).toHaveCount(0);
  await expect(p.getByTestId('share-download')).toHaveCount(0);
  await expect(p.getByTestId('share-copy-link')).toBeDisabled();
  await expect(p.getByTestId('share-x')).toBeDisabled();
});

test('Ecosystem history: a long full re-read is not a gap; each gap says what ended it (from what the scans recorded)', async ({ page }) => {
  const H = 3_600_000;
  const now = Date.now();
  const hourStart = Math.floor(now / H) * H;
  const iso = (ms: number) => new Date(ms).toISOString();
  const pt = (finish: number, o: { startedAt?: number; sweep?: 'full' | 'incremental' } = {}) => ({
    at: iso(finish),
    ...(o.startedAt !== undefined ? { startedAt: iso(o.startedAt) } : {}),
    block: Math.floor(finish / 1000),
    hash: null,
    sweep: o.sweep ?? 'incremental',
    complete: true,
    v: { rules: 'r', engine: 'e', reader: 'x', prices: 'p', history: 'hist-1.0.0' },
    risk: { all: [10, 2, 1, 0], '1k': [10, 2, 1, 0], '10k': [5, 1, 1, 0], '100k': [1, 0, 0, 0] },
    mix: { CARRY: 3 },
    venues: { tydro: 5, nado: 9, both: 1 },
    known: 20,
    drawn: 13,
    dark: 0,
    stress: null,
  });
  const hourly = (h: number) => pt(hourStart - h * H + 5 * 60_000, { startedAt: hourStart - h * H });
  const points = [
    // hourly, then a full re-read recorded before start times existed (finished 2 h 15 after the last point): a gap
    ...[40, 39, 38, 37].map(hourly),
    pt(hourStart - 35 * H + 20 * 60_000, { sweep: 'full' }),
    // hourly, then a full re-read that started on the hour and ran 80 minutes — a scan in progress, not a gap
    ...[34, 33, 32, 31, 30, 29].map(hourly),
    pt(hourStart - 28 * H + 80 * 60_000, { sweep: 'full', startedAt: hourStart - 28 * H }),
    hourly(26),
    // then nothing started for almost 3 hours: a real gap
    ...Array.from({ length: 23 }, (_, i) => 23 - i).map(hourly).filter((p) => Date.parse(p.at) < now),
  ];
  const months = [...new Set(points.map((p) => p.at.slice(0, 7)))];
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/v1/data/history/**', (route) => {
    const u = new URL(route.request().url()).pathname;
    if (u.endsWith('/history/index.json'))
      return route.fulfill(json({ v: 1, kind: 'aegis-history-index', version: 'hist-1.0.0', shards: 64, months, baselined: [], compacted: [], firstAt: points[0]!.at, firstBlock: points[0]!.block, changeMonths: [] }));
    const m = u.match(/\/history\/agg\/(\d{4}-\d{2})\.json$/);
    if (m) return route.fulfill(json({ v: 1, kind: 'aegis-history-agg', chainId: 57073, month: m[1], points: points.filter((p) => p.at.startsWith(m[1]!)) }));
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('/intel');
  // a locked build (well not yet verified) shows no history at all — run with VITE_WELL_PREVIEW=1 to cover this
  await expect(page.getByTestId('intel-history').or(page.getByText('Locked with the well until the readings are verified against the official apps.'))).toBeVisible();
  test.skip((await page.getByTestId('intel-history').count()) === 0, 'history is locked in this build');
  const h = page.getByTestId('intel-history');
  await expect(h.getByText(/no scan \(2\)/)).toBeVisible({ timeout: 15_000 });
  const d = h.getByTestId('scan-gaps');
  await d.locator('summary').click();
  await expect(d).toContainText('why the 2 gaps?');
  const rows = d.getByTestId('scan-gaps-table').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  // newest first: the real outage (nothing running), then the old full re-read without a start time
  await expect(rows.nth(0)).toContainText('an hourly scan that started');
  await expect(rows.nth(0)).toContainText('Nothing was running before it.');
  await expect(rows.nth(1)).toContainText("start time wasn't recorded");
  await expect(d).toContainText('longest 1 h 20 min');
  if (process.env.SHOT) await h.screenshot({ path: process.env.SHOT });
});

test('Accounts off (no function / not set up): no sign-in anywhere, and the pages say so', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('footer')).toBeVisible();
  await expect(page.getByTestId('nav-signin')).toHaveCount(0);
  await page.goto('/signin');
  await expect(page.getByTestId('accounts-off')).toBeVisible();
});

test('Accounts: sign in by emailed link — no password, no wallet; the link is used by a button, then the account shows', async ({ page }) => {
  let signedIn = false;
  const posts: Array<{ path: string; body: unknown }> = [];
  await page.route('**/api/v1/auth/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1/auth/', '');
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === 'me') return json(200, signedIn ? { configured: true, signedIn: true, access: 'free', email: 'trader@example.com', plan: null, paidUntil: null, since: '2026-10-09T00:00:00Z' } : { configured: true, signedIn: false, access: 'free' });
    posts.push({ path, body: req.postDataJSON() });
    if (path === 'start') return json(200, { sent: true });
    if (path === 'verify') {
      signedIn = true;
      return json(200, { signedIn: true, next: '/account' });
    }
    if (path === 'signout') {
      signedIn = false;
      return json(200, { signedIn: false });
    }
    return json(404, {});
  });
  await page.goto('/');
  await page.getByTestId('nav-signin').click();
  await expect(page).toHaveURL(/\/signin$/);
  await page.getByTestId('signin-email').fill('trader@example.com');
  await page.getByTestId('signin-send').click();
  await expect(page.getByTestId('signin-sent')).toContainText('trader@example.com');
  expect(posts[0]).toEqual({ path: 'start', body: { email: 'trader@example.com' } });
  // the emailed link: token in the fragment; it is taken out of the address bar and used only by the button
  const token = 'A'.repeat(43);
  await page.goto(`/auth/verify#t=${token}`);
  await expect(page).toHaveURL(/\/auth\/verify$/);
  expect(posts.filter((p) => p.path === 'verify')).toHaveLength(0);
  await page.getByTestId('verify-go').click();
  await expect(page).toHaveURL(/\/account$/);
  expect(posts.find((p) => p.path === 'verify')?.body).toEqual({ token });
  await expect(page.getByTestId('account-email')).toHaveText('trader@example.com');
  await expect(page.getByTestId('account-plan')).toContainText('Free');
  await expect(page.getByTestId('nav-account')).toContainText('Free');
  await page.getByTestId('signout').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('nav-signin')).toBeVisible();
});

test('Accounts: a used or expired link says so and offers a new one', async ({ page }) => {
  await page.route('**/api/v1/auth/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/me')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, signedIn: false, access: 'free' }) });
    return route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: { code: 'LINK_USED_OR_EXPIRED', message: 'This sign-in link was already used or has expired. Ask for a new one.' } }) });
  });
  await page.goto(`/auth/verify#t=${'B'.repeat(43)}`);
  await page.getByTestId('verify-go').click();
  await expect(page.getByTestId('verify-error')).toContainText('already used or has expired');
});

/* ── paywall (docs/PAYWALL.md) ── */
async function serveMe(page: Page, me: Record<string, unknown>) {
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }));
}

test('Paywall on, no plan: the address field stays free; Well, Pressure, Intel and Scan are locked and their data is never requested', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, signedIn: false, access: 'free' });
  const dataCalls: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url()).pathname;
    // the free files (Checks, track record) may load for the public record; nothing else may
    if (u.startsWith('/api/v1/data/') && !u.startsWith('/api/v1/data/subs/') && !/\/(verification-log|history\/accountability|history\/forecast-score)\.json$/.test(u)) dataCalls.push(u);
  });
  await page.goto('/');
  await expect(page.getByTestId('paste-input')).toBeVisible();
  await expect(page.getByTestId('home-preview')).toBeVisible();
  await expect(page.getByTestId('feature-well')).toContainText('DEMO DATA — MADE-UP TEST WALLETS');
  // the free promise is only what's free
  await expect(page.getByTestId('home-sub')).toContainText('position type and liquidation risk — free');
  await expect(page.getByTestId('home-sub')).not.toContainText('response to simulated market moves');
  await expect(page.getByTestId('nav-subscribe')).toBeVisible();
  await expect(page.getByTestId('well-loading')).toHaveCount(0);
  for (const [path, heading] of [['/pressure', 'Pressure'], ['/intel', 'Intel'], ['/census', 'Scan']] as const) {
    await page.goto(path);
    await expect(page.getByTestId('locked-page')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: heading, exact: true })).toBeVisible();
  }
  await page.getByTestId('locked-page').getByTestId('cta-plans').click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByTestId('plan-pro')).toContainText('$19');
  await expect(page.getByTestId('plan-desk')).toContainText('$99');
  await expect(page.getByTestId('subscribe-pro')).toHaveText('Sign in to subscribe');
  expect(dataCalls).toEqual([]);
});

test('Paywall on, no plan: a wallet page shows its risk and types; the detail is locked; test wallets stay fully open', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, signedIn: true, email: 'a@b.co', access: 'free', plan: null, paidUntil: null });
  await page.goto('/hull/0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560');
  await expect(page.getByTestId('hull-plate')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('hull-temp')).toBeVisible();
  await expect(page.getByTestId('locked-wallet')).toBeVisible();
  await expect(page.getByTestId('pose-panel')).toHaveCount(0);
  await expect(page.getByTestId('wallet-history')).toHaveCount(0);
  await expect(page.getByTestId('share-panel')).toBeVisible();
  await expect(page.getByTestId('locked-signin')).toHaveCount(0); // already signed in: only "See plans"
  await page.goto('/fixture/carry');
  await expect(page.getByTestId('pose-panel')).toBeVisible();
  await expect(page.getByTestId('locked-wallet')).toHaveCount(0);
});

test('Paywall on, with a plan: everything opens; the header shows the plan, no Subscribe', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, signedIn: true, email: 'a@b.co', access: 'pro', plan: 'pro', paidUntil: '2099-01-01T00:00:00Z' });
  await page.goto('/pressure');
  await expect(page.getByTestId('locked-page')).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByTestId('locked-well')).toHaveCount(0);
  await expect(page.getByTestId('nav-subscribe')).toHaveCount(0);
  await expect(page.getByTestId('nav-account')).toContainText('Pro');
  await page.goto('/pricing');
  await expect(page.getByTestId('current-pro')).toContainText('Your plan');
});

/* ── billing (docs/BILLING.md) ── */
test('Plans with payments on: Subscribe opens NOWPayments (crypto, on their page); renewing your own plan says it adds to the end', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, billing: true, signedIn: true, email: 'a@b.co', access: 'pro', plan: 'pro', paidUntil: '2099-01-01T00:00:00Z' });
  const bodies: unknown[] = [];
  await page.route('**/api/v1/billing/checkout', (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'https://nowpayments.io/payment/?iid=123' }) });
  });
  await page.route('https://nowpayments.io/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>NOWPayments</title>pay here' }));
  await page.goto('/pricing');
  await expect(page.getByTestId('current-pro')).toContainText('paid to');
  await expect(page.getByTestId('subscribe-pro')).toHaveText('Add 30 days — pay in crypto');
  await expect(page.getByTestId('plan-desk')).toContainText('Switching plans starts a fresh 30 days');
  await page.getByTestId('subscribe-desk').click();
  await expect(page).toHaveURL(/nowpayments\.io\/payment/);
  expect(bodies).toEqual([{ plan: 'desk' }]);
});

test('Plans: a failed checkout says so and opens nothing; an unexpected payment address is refused', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, billing: true, signedIn: true, email: 'a@b.co', access: 'free', plan: null, paidUntil: null });
  let n = 0;
  await page.route('**/api/v1/billing/checkout', (route) =>
    ++n === 1
      ? route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PAYMENT_PROVIDER', message: "The payment page couldn't be opened just now — try again in a minute." } }) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'https://evil.example/pay' }) }),
  );
  await page.goto('/pricing');
  await page.getByTestId('subscribe-pro').click();
  await expect(page.getByTestId('checkout-error')).toContainText("couldn't be opened");
  await page.getByTestId('subscribe-pro').click();
  await expect(page.getByTestId('checkout-error')).toContainText('Unexpected payment page address');
  await expect(page).toHaveURL(/\/pricing$/);
});

test('Back from paying: the account waits for the on-chain confirmation, then shows the plan and the payment', async ({ page }) => {
  let paid = false;
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        paid
          ? { configured: true, paywall: true, billing: true, signedIn: true, email: 'a@b.co', access: 'pro', plan: 'pro', paidUntil: '2026-12-01T00:00:00Z', payments: [{ at: new Date().toISOString(), plan: 'pro', usd: 19, paidUntil: '2026-12-01T00:00:00Z' }] }
          : { configured: true, paywall: true, billing: true, signedIn: true, email: 'a@b.co', access: 'free', plan: null, paidUntil: null, payments: [] },
      ),
    }),
  );
  await page.clock.install();
  await page.goto('/account?paid=1');
  await expect(page.getByTestId('paid-waiting')).toBeVisible();
  paid = true;
  await page.clock.runFor(16_000);
  await expect(page.getByTestId('paid-applied')).toContainText('Pro is paid to 1 Dec 2026');
  await expect(page.getByTestId('account-payments')).toContainText('$19');
});

test('Terms page: read-only, not advice, nothing renews by itself, refunds stated; linked from the footer and plans', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('footer').getByRole('link', { name: 'terms' }).click();
  await expect(page).toHaveURL(/\/terms$/);
  const t = page.getByTestId('terms-page');
  await expect(page.getByTestId('terms-alerts')).toContainText("Don't rely on them as your only warning");
  await expect(page.getByTestId('terms-privacy')).toContainText('Telegram chat id (stored encrypted)');
  await expect(page.getByTestId('terms-privacy')).toContainText('never the key itself');
  await expect(t).toContainText('It is read-only.');
  await expect(t).toContainText('not financial, investment, legal or tax advice');
  await expect(t).toContainText('Nothing renews or charges by itself.');
  await expect(page.getByTestId('refunds')).toContainText('Paid twice by mistake');
});

/* ── the product shown honestly to visitors without a plan ── */
test('Home without a plan: actions, public record, four previews from TEST wallets only — and no paid file requested', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, billing: true, signedIn: false, access: 'free' });
  const paid: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url()).pathname;
    if (u.startsWith('/api/v1/data/') && !/\/(verification-log|history\/accountability|history\/forecast-score)\.json$/.test(u) && !u.startsWith('/api/v1/data/subs/')) paid.push(u);
  });
  await page.goto('/');
  const p = page.getByTestId('home-preview');
  await expect(p).toBeVisible();
  for (const id of ['cta-check', 'demo-wallet-link', 'cta-plans', 'cta-signin']) await expect(p.getByTestId(id).first()).toBeVisible();
  await expect(p.getByTestId('demo-note')).toContainText('made up');
  // public evidence: chain and rules always; what isn't recorded here says so — never a zero
  const ev = p.getByTestId('public-evidence');
  await expect(ev).toContainText('Ink · 57073');
  await expect(ev).toContainText('v1.2.0');
  await expect(ev).toContainText(/not recorded yet|unavailable|loading/);
  for (const k of ['well', 'pressure', 'intel', 'scan']) await expect(p.getByTestId(`feature-${k}`)).toBeVisible();
  await expect(p.getByTestId('feature-pressure')).toContainText('SIMULATION, NOT PREDICTION');
  await expect(p.getByTestId('feature-intel')).toContainText('STRUCTURE — NO DATA SHOWN');
  // demo rows are the test wallets, linking to their fixture pages
  await expect(p.getByTestId('feature-well').getByRole('link', { name: 'carry' })).toHaveAttribute('href', '/fixture/carry');
  // Check a wallet focuses the address field
  await p.getByTestId('cta-check').click();
  await expect(page.getByTestId('paste-input')).toBeFocused();
  await p.getByTestId('demo-wallet-link').first().click();
  await expect(page).toHaveURL(/\/fixture\/carry$/);
  await expect(page.getByTestId('fixture-banner')).toBeVisible();
  expect(paid).toEqual([]);
});

test('Locked Pressure, Intel and Scan explain themselves differently; each has a safe preview and the ways in', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, signedIn: false, access: 'free' });
  const seen: string[] = [];
  for (const [path, words] of [['/pressure', 'Simulation, not prediction'], ['/intel', 'Follow liquidations and oracle events'], ['/census', 'See coverage against each protocol']] as const) {
    await page.goto(path);
    const l = page.getByTestId('locked-page');
    await expect(l).toBeVisible();
    await expect(l).toContainText(words);
    await expect(l.getByTestId('demo-wallet-link')).toBeVisible();
    await expect(l.getByTestId('cta-plans')).toBeVisible();
    await expect(l.getByTestId('cta-signin')).toBeVisible();
    await expect(l.locator('.feature-caps li')).toHaveCount(3);
    seen.push((await l.locator('.feature-problem').textContent()) ?? '');
  }
  expect(new Set(seen).size).toBe(3);
});

test('Pricing: who each plan is for, a truthful comparison (alerts and webhooks COMING SOON), proof links, payment terms kept', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, billing: true, signedIn: false, access: 'free' });
  await page.goto('/pricing');
  await expect(page.getByTestId('for-free')).toContainText('Checking an individual wallet');
  await expect(page.getByTestId('for-desk')).toContainText('automated integrations');
  const c = page.getByTestId('plan-compare');
  await expect(c.getByRole('row', { name: /Telegram alerts/ })).toContainText('COMING SOON');
  await expect(c.getByRole('row', { name: /Webhooks/ })).not.toContainText('INCLUDED · ');
  await expect(c.getByRole('row', { name: /^Webhooks/ }).locator('td').nth(2)).toContainText('COMING SOON');
  await expect(c.getByRole('row', { name: /The Well/ }).locator('td').first()).toContainText('NOT INCLUDED');
  const proof = page.getByTestId('plan-proof');
  await expect(proof.getByTestId('demo-wallet-link')).toHaveAttribute('href', '/fixture/carry');
  await expect(proof.getByRole('link', { name: /API documentation/ })).toHaveAttribute('href', '/developers');
  const note = page.getByTestId('pricing-page');
  for (const t of ['NOWPayments', 'never connects', 'no automatic renewal', 'lasts 30 days', 'read-only', 'not financial', 'Terms and refunds']) await expect(note).toContainText(t);
  await expect(page.getByTestId('plan-pro')).toContainText('$19');
  await expect(page.getByTestId('plan-desk')).toContainText('$99');
});

test('Checks: the track record guide defines coverage, follow-through and lead time — no overall accuracy', async ({ page }) => {
  await page.goto('/calibration');
  const g = page.getByTestId('track-guide');
  for (const t of ['Warning coverage', 'Warning follow-through', 'Warning lead time', 'No single number is presented as overall accuracy', 'baseline', 'still awaiting outcome', 'neither a hit nor a miss']) await expect(g).toContainText(t);
  await expect(page.getByTestId('track-record')).toBeVisible();
});

test('Wallet read: real per-venue stages while reading, seconds counted, never a zero', async ({ page }) => {
  await page.goto('/hull/0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560');
  const rp = page.getByTestId('read-progress');
  // the read in this sandbox fails fast or completes; either way the progress panel shows only real stage words
  await expect(page.getByTestId('hull-plate').or(rp)).toBeVisible({ timeout: 30_000 });
  if (await rp.count()) {
    await expect(rp).toContainText('Most reads complete within 5–15 seconds');
    await expect(rp).not.toContainText(/\b0 wallets\b/);
  }
});

/* ── Telegram alerts for accounts (docs/ALERTS.md) ── */
test('Alerts live, Pro account: Connect Telegram gives a one-time t.me link, the page notices the link, wallets and lines are edited, pause works', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, billing: true, alerts: true, signedIn: true, email: 'a@b.co', access: 'pro', plan: 'pro', paidUntil: '2099-01-01T00:00:00Z' });
  const A = '0x00000000000000000000000000000000000a1e71';
  let st: Record<string, unknown> = { enabled: true, signedIn: true, live: true, bot: 'PhrouraxBot', limit: 10, linked: false, linkedAt: null, paused: false, protocol: false, watches: [], lastRun: null };
  const posts: Array<{ path: string; body: unknown }> = [];
  await page.route('**/api/v1/alerts/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1/alerts/', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (path === 'me') return json(st);
    const body = req.postDataJSON() as Record<string, unknown>;
    posts.push({ path, body });
    if (path === 'link') {
      st = { ...st, linked: true, linkedAt: Date.now() }; // the bot answered /start
      return json({ url: 'https://t.me/PhrouraxBot?start=AbCdEfGhIjKlMnOpQrStUvWx', expiresInS: 600 });
    }
    if (path === 'watch') {
      const prev = (st.watches as Array<Record<string, unknown>>).find((w) => w.address === body.address);
      const w = { address: body.address, venue: body.venue ?? 'any', hfBelow: body.hfBelow ? Number(body.hfBelow) : null, bufferPct: null, scenario: (body.scenario as object) ?? null, overLimit: false, level: prev ? 'WATCH' : null, checkedAt: prev ? Date.now() - 120_000 : null };
      st = { ...st, watches: prev ? [w] : [...(st.watches as unknown[]), w] };
      return json(st);
    }
    if (path === 'settings') {
      st = { ...st, ...body };
      return json(st);
    }
    return json(st);
  });
  await page.goto('/');
  await expect(page.getByTestId('nav-alerts')).toHaveAccessibleName('Alerts');
  await expect(page.getByTestId('nav-alerts')).not.toContainText('SOON');
  await page.getByTestId('nav-alerts').click();
  await expect(page.getByTestId('alerts-page')).toHaveAttribute('data-live', 'yes');
  await expect(page.getByTestId('alerts-unavailable')).toHaveCount(0);
  await page.getByTestId('alerts-connect-btn').click();
  await expect(page.getByTestId('alerts-open-telegram')).toHaveAttribute('href', /^https:\/\/t\.me\/PhrouraxBot\?start=/);
  await expect(page.getByTestId('alerts-linked')).toContainText('@PhrouraxBot', { timeout: 10_000 });

  await page.getByTestId('alerts-add-input').fill(A);
  await page.getByTestId('alerts-add-btn').click();
  await expect(page.getByTestId('alerts-row')).toHaveCount(1);
  await expect(page.getByTestId('alerts-count')).toHaveText('1 / 10');
  await page.getByTestId('alerts-edit').click();
  await page.getByTestId('alerts-hf').fill('1.3');
  await page.getByTestId('alerts-save').click();
  await expect(page.getByTestId('alerts-row')).toContainText('HF < 1.30');
  await expect(page.getByTestId('alerts-level')).toHaveText('WATCH');
  await page.getByTestId('alerts-pause').click(); // controlled: it ticks once the server has saved it
  await expect(page.getByTestId('alerts-pause')).toBeChecked();
  expect(posts.map((p) => p.path)).toEqual(['link', 'watch', 'watch', 'settings']);
  expect(posts[2]!.body).toMatchObject({ address: A, hfBelow: '1.3', scenario: null });

  await page.goto('/pricing');
  await expect(page.getByTestId('plan-compare').getByRole('row', { name: /Telegram alerts/ })).toContainText('INCLUDED · up to 10 wallets');
});

test('Alerts live, no plan: the page explains the plans and offers no Connect button', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, alerts: true, signedIn: true, email: 'a@b.co', access: 'free', plan: null, paidUntil: null });
  await page.route('**/api/v1/alerts/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, signedIn: true, live: true, bot: 'PhrouraxBot', limit: 0, linked: false, watches: [] }) }));
  await page.goto('/watch');
  await expect(page.getByTestId('alerts-needs-plan')).toContainText('Pro watches 10 wallets, Desk 100');
  await expect(page.getByTestId('alerts-connect-btn')).toHaveCount(0);
  await page.getByTestId('alerts-choose-plan').click();
  await expect(page).toHaveURL(/\/pricing$/);
});

/* ── Desk API keys (docs/API.md) ── */
test('Account, Desk: make an API key (shown once, copyable), see it listed by its last 4, revoke it', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, billing: true, signedIn: true, email: 'd@b.co', access: 'desk', plan: 'desk', paidUntil: '2099-01-01T00:00:00Z' });
  const KEY = 'phx_' + 'A'.repeat(28) + 'wXyZ';
  let keys: Array<Record<string, unknown>> = [];
  await page.route('**/api/v1/keys**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (status: number, b: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'GET') return json(200, { desk: true, max: 5, keys });
    if (path.endsWith('/revoke')) {
      keys = [];
      return json(200, { keys });
    }
    keys = [{ id: 'key_1', name: (req.postDataJSON() as { name: string }).name, hint: 'wXyZ', createdAt: new Date().toISOString(), lastUsedAt: null }];
    return json(201, { key: KEY, keys });
  });
  await page.goto('/account');
  const p = page.getByTestId('api-keys');
  await expect(p).toContainText('0 / 5');
  await page.getByTestId('api-key-name').fill('trading-bot');
  await page.getByTestId('api-key-create').click();
  await expect(page.getByTestId('api-key-value')).toHaveText(KEY);
  await expect(page.getByTestId('api-key-fresh')).toContainText('SHOWN ONCE');
  await expect(page.getByTestId('api-key-name')).toHaveCount(0); // no new key while one is on screen
  await page.getByTestId('api-key-done').click();
  await expect(page.getByTestId('api-key-value')).toHaveCount(0);
  await expect(page.getByTestId('api-keys-table')).toContainText('phx_…wXyZ');
  await expect(page.getByTestId('api-keys-table')).toContainText('trading-bot');
  await expect(page.getByTestId('api-keys-table')).not.toContainText(KEY);
  await page.getByTestId('api-key-revoke').click();
  await expect(page.getByTestId('api-keys-table')).toHaveCount(0);
});

test('Account, Pro: API keys say they come with Desk; no create form', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, billing: true, signedIn: true, email: 'p@b.co', access: 'pro', plan: 'pro', paidUntil: '2099-01-01T00:00:00Z' });
  await page.route('**/api/v1/keys', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ desk: false, max: 5, keys: [] }) }));
  await page.goto('/account');
  await expect(page.getByTestId('api-keys-locked')).toContainText('Desk plan');
  await expect(page.getByTestId('api-key-create')).toHaveCount(0);
});

test('Developers with webhooks on: how to create one with a key; Pricing says webhooks and keys are included for Desk', async ({ page }) => {
  await serveMe(page, { configured: true, paywall: true, billing: true, webhooks: true, signedIn: false, access: 'free' });
  await page.goto('/developers');
  await expect(page.getByTestId('webhooks-live')).toContainText('Authorization: Bearer phx_');
  await expect(page.getByTestId('webhooks-not-live')).toHaveCount(0);
  await expect(page.getByTestId('dev-paid')).toContainText('API key');
  await page.goto('/pricing');
  const c = page.getByTestId('plan-compare');
  await expect(c.getByRole('row', { name: /^Webhooks/ })).toContainText('INCLUDED · up to 5 endpoints');
  await expect(c.getByRole('row', { name: /every other endpoint/ })).toContainText('API keys');
  await expect(page.getByTestId('plan-desk')).not.toContainText('when they open');
});
