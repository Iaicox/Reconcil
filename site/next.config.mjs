// Static export for GitHub Pages. `next build` emits a fully static `out/` (no Node server),
// which the Pages workflow uploads. `basePath`/`assetPrefix` come from NEXT_PUBLIC_BASE_PATH:
// unset for `next dev` (served at /), set to "/Reconcil" by the Pages workflow (project site
// lives under github.io/Reconcil/). A future custom domain sets it back to "" via a CNAME.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This app has its own lockfile but sits inside the pnpm monorepo; pin the tracing root
  // to this dir so Next doesn't infer the repo root (and warn about multiple lockfiles).
  outputFileTracingRoot: import.meta.dirname,
  output: 'export',
  // Static export can't use the on-demand image optimizer.
  images: { unoptimized: true },
  // Pages serves `/route/` -> `/route/index.html`; trailing slashes keep asset URLs stable.
  trailingSlash: true,
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
};

export default nextConfig;
