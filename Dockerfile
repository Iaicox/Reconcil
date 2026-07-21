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
EXPOSE 8484
CMD ["node", "apps/mcp-server/dist/http.js"]
