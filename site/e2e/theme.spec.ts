import { expect, test } from '@playwright/test';

// Paper tokens — the observable "which theme am I in" signal.
const LIGHT = 'rgb(241, 244, 240)';
const DARK = 'rgb(10, 13, 11)';

const bodyBg = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

const toggle = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /switch/i }).first();

test.describe('system default (no stored choice)', () => {
  test('follows light scheme', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme');
    expect(await bodyBg(page)).toBe(LIGHT);
  });

  test.describe('dark scheme', () => {
    test.use({ colorScheme: 'dark' });

    test('follows dark scheme', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).not.toHaveAttribute('data-theme');
      expect(await bodyBg(page)).toBe(DARK);
    });
  });
});

test('toggle overrides the system scheme and persists across reload', async ({ page }) => {
  await page.goto('/');
  await toggle(page).click();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bodyBg(page)).toBe(DARK);
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
  // Browser chrome follows the manual choice too.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
    'dark',
  );
  for (const content of await page
    .locator('meta[name="theme-color"]')
    .evaluateAll((metas) => metas.map((m) => m.getAttribute('content')))) {
    expect(content).toBe('#0a0d0b');
  }
  // Post-mount accessible name announces the state.
  await expect(toggle(page)).toHaveAccessibleName('Switch to light theme');

  // The system still says light — the stored choice must win after reload.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bodyBg(page)).toBe(DARK);
});

test.describe('toggling back under a dark system scheme', () => {
  test.use({ colorScheme: 'dark' });

  test('first click flips to light', async ({ page }) => {
    await page.goto('/');
    await toggle(page).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await bodyBg(page)).toBe(LIGHT);
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');
  });
});

test('stored choice applies before first paint (init script)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // The parser-blocking init script must have stamped the attribute already — no flash of
  // the light theme while React hydrates.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bodyBg(page)).toBe(DARK);
  for (const content of await page
    .locator('meta[name="theme-color"]')
    .evaluateAll((metas) => metas.map((m) => m.getAttribute('content')))) {
    expect(content).toBe('#0a0d0b');
  }
});

test('toggle icon tracks the effective theme', async ({ page }) => {
  await page.goto('/');
  const [moon, sun] = [
    toggle(page).locator('span[aria-hidden]').first(),
    toggle(page).locator('span[aria-hidden]').last(),
  ];
  // Light: the moon ("switch to dark") is the visible icon.
  await expect(moon).toBeVisible();
  await expect(sun).toBeHidden();
  await toggle(page).click();
  await expect(sun).toBeVisible();
  await expect(moon).toBeHidden();
});
