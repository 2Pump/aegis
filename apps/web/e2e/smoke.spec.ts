import { expect, test } from '@playwright/test';

test('home boots gated: no well, no fixture stars, camera footer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('unverified-banner')).toBeVisible();
  await expect(page.getByTestId('well-canvas')).toHaveCount(0);
  await expect(page.getByText('EX1 CARRY')).toHaveCount(0);
  await expect(page.getByTestId('footer')).toContainText('AEGIS is a camera. It cannot move your funds. Classifications can be wrong.');
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

test('Pressure Map: in the nav between Well and Scan; locked with the well until verified (no numbers shown)', async ({ page }) => {
  await page.goto('/');
  const links = await page.locator('nav.nav a').allInnerTexts();
  expect(links.map((l) => l.trim().toUpperCase()).slice(0, 3)).toEqual(['WELL', 'PRESSURE', 'SCAN']);
  await page.getByRole('link', { name: 'Pressure' }).click();
  await expect(page).toHaveURL(/\/pressure$/);
  await expect(page.getByTestId('pressure-locked')).toBeVisible();
  await expect(page.locator('footer, .footer').first()).toContainText('AEGIS is a camera. It cannot move your funds. Classifications can be wrong.');
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

test('Alerts: labelled NOT LIVE, no sign-up form, no bot link, privacy stated', async ({ page }) => {
  await page.goto('/watch');
  await expect(page.getByTestId('alerts-unavailable')).toContainText('NOT LIVE YET');
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
