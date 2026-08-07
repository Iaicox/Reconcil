// Flat config, replacing `next lint` (removed in Next 16 — see site/README.md) and the
// legacy `.eslintrc.json`. `eslint-config-next/core-web-vitals` is itself a flat-config
// array in eslint-config-next@16 (no separate `/flat` entrypoint needed — the package
// dropped the legacy `.eslintrc` export entirely and moved the same rule surface to the
// package root); we spread it and layer repo-specific ignores on top.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const config = [
  {
    // Generated output only exercised locally (playwright-report/, test-results/) or by
    // `next build` (.next/, out/); `eslint-config-next` already ignores the latter two but
    // not the Playwright artifacts.
    ignores: ['playwright-report/**', 'test-results/**'],
  },
  ...nextCoreWebVitals,
];

export default config;
