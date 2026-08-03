import { defineConfig, devices } from '@playwright/test';

// E2E for the static export — `npm test` builds `out/` first, so the suite always runs
// against exactly what ships to Pages (basePath-less variant; the /Reconcil prefix is
// exercised by the pages.yml build). Locally you can keep `npx serve out -l 4787` running
// and re-run tests against it (reuseExistingServer).
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:4787',
    colorScheme: 'light',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npx serve out -l 4787',
    url: 'http://localhost:4787',
    reuseExistingServer: !process.env.CI,
  },
});
