# One image, two commands (00-overview §2): compose overrides `command` for
# the worker; the default runs the streamable HTTP MCP server.
#
# The base tag pins the MINOR, so the image cannot drift onto a different Node minor
# between builds without someone choosing it. Patches still float, which is where security
# fixes arrive, and Dependabot watches this file (.github/dependabot.yml) so the pin is
# maintained rather than quietly aging.
#
# WHICH MAJOR: LTS lines only. A Dependabot major is accepted once that major has ENTERED
# LTS, not when it is released — a `Current` release in the production image means shipping
# a runtime no LTS-tracking self-hoster has. That is why the 2026-09 bump took 24.x (Active
# LTS since 2025-10, EOL 2028-04) over the offered 26.8, which is Current until 2026-10-28.
# Node 26 is the next major to accept, on or after that date.
#
# WHOEVER TAKES 26: it is not a tag change. corepack has been UNBUNDLED from the Node
# distribution — `node:26.8-slim` has npm but no corepack at all, so the `corepack enable
# pnpm` below dies with "corepack: not found" on the second build step. (Measured 2026-09-13:
# node:24.21-slim ships corepack 0.36.0; node:26.8-slim ships none.) Replacing it means
# choosing how pnpm gets in — `npm i -g corepack` first, or installing pnpm directly — and
# only the first keeps `packageManager: pnpm@11.26.0` in package.json enforced, which is the
# whole reason corepack is here. Note CI would NOT catch this: it installs pnpm via
# pnpm/action-setup, so only the shipped image breaks, and `e2e-smoke` is cron/dispatch-only.
#
# The tag now MATCHES .nvmrc, which it deliberately did not before: node:22.22-slim was
# chosen over .nvmrc's 22.13 because that image bundles a corepack whose embedded signing
# keys predate npm's key rotation, so `pnpm fetch` died on "Cannot find matching keyid"
# before a single dependency was downloaded. 24.x ships current keys, so the divergence is
# no longer needed. Kept as history because the trap recurs: if a future pin ever fails that
# way, the fix is a newer minor — never COREPACK_INTEGRITY_KEYS=0, which would trade a
# build error for an unverified toolchain.

FROM node:24.21-slim AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm build
# Drop the eval runner HERE, in the builder, so the runtime stage's COPY never sees it.
# Deleting it after the COPY instead would only add a whiteout layer: the bytes would still
# sit in the layer below, reachable through `docker save` / `docker history`, and the image
# would be no smaller. It has to exist during install+build (the workspace lockfile covers
# it) and is needed by nothing afterwards — the image runs mcp-server and worker, and
# nothing in compose, the guide or the README invokes anything from apps/cli.
#
# Why it must not ship: the runner drives live LLM traffic and, when DATABASE_URL is unset,
# starts a throwaway Postgres CONTAINER — which is why apps/cli legitimately carries
# @testcontainers/postgresql in `dependencies`, and why that manifest kept drawing review
# comments. The manifest was never the defect; shipping the runner was. (The package itself
# still sits in the shared pnpm store until the deferred `pnpm deploy --prod` slice.)
RUN rm -rf apps/cli
# NOTE: no `pnpm prune --prod` — in this workspace it both aborts without a TTY
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) and, once forced, strips hoisted
# prod deps (e.g. pg) that a workspace app still needs at runtime. We ship the
# full node_modules; slimming via `pnpm deploy --prod` is a later size optimization.

FROM node:24.21-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app /app
# NOTE: still ships sources + devDependencies from the builder stage (see the
# `pnpm prune --prod` note above) — a full prod-slim rebuild (`--prod` install
# / dist-only copy) is a deliberately deferred separate slice. The eval runner is already
# gone at this point — removed in the builder, so it is absent from this layer rather than
# hidden behind a whiteout.
# node:24.21-slim ships a pre-created `node` user (uid 1000). `/app` is root-owned
# from the COPY above (world-readable, so `node` can still read + exec it); the
# one path either command writes to at runtime is the exports dir (close-pack /
# PDF / journal-drafts tools, RECONCIL_EXPORT_DIR default `./exports` — gitignored,
# so it does not exist in the builder stage), which must be pre-created and
# owned by `node` so the bind/named volume mount inherits that ownership.
RUN mkdir -p /app/exports && chown node:node /app/exports
USER node
# Documentation only: EXPOSE binds nothing. It names config.ts DEFAULT_PORT, and a PORT
# override moves the listener without moving this line — there is no dynamic form short of
# a build arg, which would only push the same duplication into the build. docker-compose.yml
# is the authority that actually tracks the override ("${PORT:-8484}:${PORT:-8484}", with
# its own comment on why it is not hardcoded).
EXPOSE 8484
CMD ["node", "apps/mcp-server/dist/http.js"]
