import { expect, test } from '@playwright/test';

// Honesty invariants: the hero figures are verbatim from the demo fixture
// (docs/design/real-materials.md) and must never be tidied, rounded differently, or
// invented. These assertions are the executable form of that rule.
test('fixture figures appear verbatim', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByText('0.37857142857142856 — rounded for display only'),
  ).toBeVisible();
  await expect(page.getByText('a35416c3-9c2a-45a1-9ca1-04298ad68bad')).toBeVisible();
  await expect(page.getByText('0.3785', { exact: true })).toBeVisible();
  // .first(): the figure also sits in the (hidden) mobile card markup.
  await expect(page.getByText('0.379', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('300 EURC', { exact: true })).toBeVisible();
  await expect(page.getByText('AWAITING YOUR CONFIRMATION').first()).toBeVisible();
  await expect(page.getByText('19 MCP tools')).toBeVisible();
});

test('the booking CTA stays withdrawn', async ({ page }) => {
  await page.goto('/');
  // Temporarily removed on user request — this guards against it sneaking back through a
  // copy edit. Delete this test when the CTA deliberately returns.
  await expect(page.getByText('Book 20 minutes')).toHaveCount(0);
});

test('repo links open safely in a new tab', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('banner');
  for (const [name, href] of [
    ['Architecture', 'https://github.com/Iaicox/Reconcil/tree/main/docs/architecture'],
    ['Repository', 'https://github.com/Iaicox/Reconcil'],
  ] as const) {
    const link = nav.getByRole('link', { name });
    await expect(link).toHaveAttribute('href', href);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
});
