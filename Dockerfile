# One image, two commands (00-overview §2): compose overrides `command` for
# the worker; the default runs the streamable HTTP MCP server.

FROM node:22-slim AS builder
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

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app /app
# NOTE: still ships sources + devDependencies from the builder stage (see the
# `pnpm prune --prod` note above) — a full prod-slim rebuild (`--prod` install
# / dist-only copy) is a deliberately deferred separate slice; this is just the
# non-root user fix.
# node:22-slim ships a pre-created `node` user (uid 1000). `/app` is root-owned
# from the COPY above (world-readable, so `node` can still read + exec it); the
# one path either command writes to at runtime is the exports dir (close-pack /
# PDF / journal-drafts tools, RECONCIL_EXPORT_DIR default `./exports` — gitignored,
# so it does not exist in the builder stage), which must be pre-created and
# owned by `node` so the bind/named volume mount inherits that ownership.
RUN mkdir -p /app/exports && chown node:node /app/exports
USER node
EXPOSE 8484
CMD ["node", "apps/mcp-server/dist/http.js"]
