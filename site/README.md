# Reconcil — landing page

Validation-phase marketing page for [Reconcil](../README.md). A single static page that states
the positioning and recruits interview subjects (a `mailto:` CTA — no signup, no SaaS).

## Why this is a standalone project (npm, not pnpm)

This directory is **deliberately outside the pnpm workspace** (the workspace globs only `apps/*`
and `packages/*`). It has its own `package.json` and `package-lock.json` and uses **npm**, so
Next.js and React never enter the product's root `pnpm-lock.yaml`, `turbo` task graph,
`depcruise` boundaries, or the ADR-011 supply-chain scan. The backend build is completely
unaffected by anything here.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4. Configured for **static
export** (`output: 'export'` in `next.config.mjs`) — `next build` emits a fully static `out/`.

## Lint

`next lint` was removed in Next 16. Linting runs via the ESLint CLI directly against a flat
config (`npm run lint` → `eslint .`, config in `eslint.config.mjs`), using the flat-config
array `eslint-config-next` exports at its package root as of v16 (same `next/core-web-vitals`
rule surface as before).

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
