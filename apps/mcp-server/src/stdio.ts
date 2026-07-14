import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './server.js';

/**
 * stdio entrypoint — the self-host default for Claude Desktop/Code (ADR-012).
 * Auth: none; process trust, single self-host tenant resolved from config.
 */
const server = createServer();
await server.connect(new StdioServerTransport());
