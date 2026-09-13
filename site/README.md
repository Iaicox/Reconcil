# Reconcil — landing page

Validation-phase marketing page for [Reconcil](../README.md). A single static page that states
the positioning and recruits interview subjects (a `mailto:` CTA — no signup, no SaaS).

## Why this is a standalone project (npm, not pnpm)

This directory is **deliberately outside the pnpm workspace** (the workspace globs only `apps/*`
and `packages/*`). It has its own `package.json` and `package-lock.json` and uses **npm**, so
Next.js and React never enter the product's root `pnpm-lock.yaml`, `turbo` task graph, or
`depcruise` boundaries. The backend build is completely unaffected by anything here.

The one deliberate exception is the ADR-011 supply-chain scan: `pnpm check:supply-chain` reads
`site/package-lock.json` too. The signing/key-material ban is about what this repository ships,
not about which package manager installed it.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4. Configured for **static
export** (`output: 'export'` in `next.config.mjs`) — `next build` emits a fully static `out/`.

## Lint

`next lint` was removed in Next 16. Linting runs via the ESLint CLI directly against a flat
config (`npm run lint` → `eslint .`, config in `eslint.config.mjs`), using the flat-config
array `eslint-config-next` exports at its package root as of v16 (same `next/core-web-vitals`
rule surface as before).

ESLint is pinned to `^9.0.0` here, deliberately *not* the root workspace catalog's `^10.0.0`
— `eslint-config-next@16.x` bundles `eslint-plugin-react`, which still calls
`context.getFilename()` (removed in ESLint 10) and crashes every run. Revisit once a newer
`eslint-config-next`/`eslint-plugin-react` supports ESLint 10.

## Dependency floors (`overrides`)

`js-yaml` is pinned to `^4.3.2` in `package.json`'s `overrides`. It is a dev-only
transitive (`@eslint/eslintrc` asks for `^4.3.0`), and `4.3.1` — which satisfies that range —
carries GHSA-2883-xcg3-v3hh. npm will not move a transitive that already satisfies its parent,
so `npm install` alone silently keeps the vulnerable resolution and `npm audit` is the only
thing that notices. The override states the floor so a lockfile regeneration cannot revert it.
Same failure mode, same remedy as the root workspace's catalog floors — see
`docs/architecture/09-known-gaps.md`, "Regenerating `pnpm-lock.yaml` does not reapply in-range
security bumps". Drop the override once `@eslint/eslintrc` raises its own range.

## Develop

```bash
cd site
npm install
npm run dev      # http://localhost:3000
```

## Build (static)

```bash
npm run build    # -> site/out/  (index.html, _next/…, .nojekyll, 404.html)
```

## Deploy — GitHub Pages

Pushing changes under `site/**` to `main` triggers `.github/workflows/pages.yml`, which builds
with `NEXT_PUBLIC_BASE_PATH=/Reconcil` and deploys `out/` to Pages.

- **One-time setup:** repo **Settings → Pages → Source = GitHub Actions**.
- Live at `https://iaicox.github.io/Reconcil/`.
- `basePath`/`assetPrefix` come from `NEXT_PUBLIC_BASE_PATH` (unset locally, `/Reconcil` in CI).
  A future custom domain sets it back to empty and adds a `CNAME` in `public/`.
