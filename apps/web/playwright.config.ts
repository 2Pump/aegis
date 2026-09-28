import { defineConfig } from '@playwright/test';

// Uses a system Chromium when PW_CHROMIUM is set (CI sandbox); otherwise Playwright's own.
const executablePath = process.env.PW_CHROMIUM || undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: executablePath ? { executablePath } : {},
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'pnpm preview',
    port: 4173,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
