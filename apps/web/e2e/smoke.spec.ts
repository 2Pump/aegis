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

test('rules page and drawer render constants', async ({ page }) => {
  await page.goto('/rules');
  await expect(page.getByText('CARRY_BAND')).toBeVisible();
  await expect(page.getByTestId('display-names')).toContainText('Unhedged bet');
  await page.getByTestId('rules-drawer-btn').click();
  await expect(page.getByTestId('rules-drawer')).toContainText('WOUNDED_HF');
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
