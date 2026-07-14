import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * One tool registry, two transports (ADR-012): stdio.ts and http.ts both
 * connect the server built here. The server is a thin adapter — tools live in
 * @pet-crypto/mcp-tools and are registered against the official SDK.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'pet-crypto',
    version: '0.0.0',
  });

  // TODO(weeks 4–5): register the tool registry from @pet-crypto/mcp-tools.

  return server;
}
