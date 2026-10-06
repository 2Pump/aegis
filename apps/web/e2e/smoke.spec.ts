import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

test('home boots gated: no well, no fixture stars, read-only footer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('unverified-banner')).toBeVisible();
  await expect(page.getByTestId('well-canvas')).toHaveCount(0);
  await expect(page.getByText('EX1 CARRY')).toHaveCount(0);
  await expect(page.getByTestId('footer')).toContainText('Phrourax is read-only. It never connects to your wallet and cannot move funds. Classifications may be incomplete or incorrect. Not financial advice.');
  await expect(page.getByTestId('footer')).toContainText('chain 57073');
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
async function serveRelease3(page: Page) {
  const month = new Date().toISOString().slice(0, 7);
  const json = (body: string) => ({ status: 200, contentType: 'application/json', body });
  await page.route('**/census/history/**', (route) => {
    const u = new URL(route.request().url()).pathname;
    if (u.endsWith('/history/index.json')) return route.fulfill(json(JSON.stringify({ v: 1, kind: 'aegis-history-index', version: 'hist-1.0.0', shards: 64, months: [], baselined: [], compacted: [], firstAt: null, firstBlock: null, changeMonths: [month] })));
    if (u.endsWith('/history/oracle/latest.json')) return route.fulfill(json(R3('oracle-latest.json')));
    if (u.endsWith(`/history/prices/${month}.json`)) return route.fulfill(json(R3('prices.json')));
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
  await page.route('**/census/history/**', (route) => {
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
    await page.unroute('**/census/history/**');
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
