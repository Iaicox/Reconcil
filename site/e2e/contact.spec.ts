import { expect, test } from '@playwright/test';

const EMAIL = 'mr.portulak@gmail.com';
const MAILTO = `mailto:${EMAIL}?subject=Reconcil%20%E2%80%94%20interview`;

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('copy button puts the address on the clipboard with feedback', async ({ page }) => {
  await page.goto('/');
  const copyBtn = page
    .getByRole('main')
    .getByRole('button', { name: 'Copy email address' })
    .first();

  await copyBtn.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(EMAIL);
  // Feedback swaps the accessible name, then reverts after ~1.5s.
  await expect(
    page.getByRole('main').getByRole('button', { name: 'Copied' }).first(),
  ).toBeVisible();
  await expect(copyBtn).toBeVisible({ timeout: 3000 });
});

test('rapid double click keeps the feedback for the full window', async ({ page }) => {
  await page.goto('/');
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Copy email address' }).first().click();
  await page.waitForTimeout(1000);
  await main.getByRole('button', { name: 'Copied' }).first().click();
  // A leftover timer from the first click would reset this ~500ms after the second click;
  // with the timer cleared it must still show at +1.3s.
  await page.waitForTimeout(1300);
  await expect(main.getByRole('button', { name: 'Copied' }).first()).toBeVisible();
});

test('address is visible as text at every contact point', async ({ page }) => {
  await page.goto('/');
  // Hero, CTA band, footer.
  expect(await page.getByText(EMAIL).count()).toBeGreaterThanOrEqual(3);
  const emailLinks = page.getByRole('link', { name: 'Email me' });
  await expect(emailLinks).toHaveCount(2);
  for (const link of await emailLinks.all()) {
    await expect(link).toHaveAttribute('href', MAILTO);
  }
});

test.describe('mobile menu', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('opens with links and the copyable address', async ({ page }) => {
    await page.goto('/');
    const banner = page.getByRole('banner');
    await banner.locator('summary').click();
    await expect(banner.getByRole('link', { name: 'Architecture' })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Repository' })).toBeVisible();
    await expect(banner.getByText(EMAIL)).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Copy email address' })).toBeVisible();
  });
});
