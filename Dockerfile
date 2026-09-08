# One image, two commands (00-overview §2): compose overrides `command` for
# the worker; the default runs the streamable HTTP MCP server.
#
# The base tag pins the MINOR, so the image cannot drift onto a different Node minor
# between builds without someone choosing it. Patches still float, which is where security
# fixes arrive, and Dependabot watches this file (.github/dependabot.yml) so the pin is
# maintained rather than quietly aging.
#
# NOT pinned to .nvmrc's 22.13, and that is deliberate: node:22.22-slim bundles a corepack
# whose embedded signing keys predate npm's key rotation, so `pnpm fetch` dies on
# "Cannot find matching keyid" before a single dependency is downloaded. .nvmrc and
# engines (>=22.13.0) are floors, not ceilings. Anyone tempted to "align the pin with
# .nvmrc" will reproduce that build failure; the fix is a newer minor, never
# COREPACK_INTEGRITY_KEYS=0, which would trade a build error for an unverified toolchain.

FROM node:22.22-slim AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm build
# NOTE: no `pnpm prune --prod` — in this workspace it both aborts without a TTY
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) and, once forced, strips hoisted
# prod deps (e.g. pg) that a workspace app still needs at runtime. We ship the
# full node_modules; slimming via `pnpm deploy --prod` is a later size optimization.

FROM node:22.22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app /app
# NOTE: still ships sources + devDependencies from the builder stage (see the
# `pnpm prune --prod` note above) — a full prod-slim rebuild (`--prod` install
# / dist-only copy) is a deliberately deferred separate slice.
#
# The eval runner is dropped here. It is a development tool that drives live LLM traffic
# and, when DATABASE_URL is unset, starts a throwaway Postgres CONTAINER — which is why
# apps/cli legitimately carries @testcontainers/postgresql in `dependencies` and why that
# manifest kept drawing review comments. The manifest was never the defect; shipping the
# runner was. Nothing in compose, the guide or the README runs anything from apps/cli, so
# the image simply does not carry it. (The package itself still sits in the shared pnpm
# store until the deferred `pnpm deploy --prod` slice; this removes the runner, not the
# last byte of its dependency.)
RUN rm -rf /app/apps/cli
# node:22.22-slim ships a pre-created `node` user (uid 1000). `/app` is root-owned
# from the COPY above (world-readable, so `node` can still read + exec it); the
# one path either command writes to at runtime is the exports dir (close-pack /
# PDF / journal-drafts tools, RECONCIL_EXPORT_DIR default `./exports` — gitignored,
# so it does not exist in the builder stage), which must be pre-created and
# owned by `node` so the bind/named volume mount inherits that ownership.
RUN mkdir -p /app/exports && chown node:node /app/exports
USER node
EXPOSE 8484
CMD ["node", "apps/mcp-server/dist/http.js"]
