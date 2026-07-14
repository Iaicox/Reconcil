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
RUN pnpm prune --prod

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 8484
CMD ["node", "apps/mcp-server/dist/http.js"]
