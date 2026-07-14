import Fastify from 'fastify';

/**
 * Minimal Fastify host (ADR-003): the entire HTTP surface is /mcp and
 * /healthz. No REST in the MVP; product logic has zero HTTP coupling.
 */
const port = Number(process.env['PORT'] ?? 8484);

const app = Fastify({ logger: true });

app.get('/healthz', () => ({ status: 'ok' }));

// TODO(weeks 4–5): mount the SDK's streamable HTTP transport here, with
// bearer-key tenant resolution (ADR-012).
app.all('/mcp', async (_request, reply) => {
  return reply
    .code(501)
    .send({ error: 'MCP streamable HTTP transport is not implemented yet (ADR-012)' });
});

await app.listen({ port, host: '0.0.0.0' });
