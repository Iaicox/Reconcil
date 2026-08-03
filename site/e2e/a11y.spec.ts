import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Axe smoke in both themes: fail on serious/critical only — the audit-grade positioning
// should hold in whichever scheme the visitor lands in.
async function seriousViolations(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
}

test('light theme has no serious violations', async ({ page }) => {
  await page.goto('/');
  expect(await seriousViolations(page)).toEqual([]);
});

test.describe('dark theme', () => {
  test.use({ colorScheme: 'dark' });

  test('has no serious violations', async ({ page }) => {
    await page.goto('/');
    expect(await seriousViolations(page)).toEqual([]);
  });
});
