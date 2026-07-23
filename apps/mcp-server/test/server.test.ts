import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolContext } from '@pet-crypto/mcp-tools';
import { describe, expect, it } from 'vitest';

import { createServer } from '../src/server.js';

/** Link a Client to a server built by createServer, in-process (no transport I/O, no DB). */
async function connect(makeContext: () => ToolContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(makeContext);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** A context whose db is never touched — valid only for paths that fail before DB access. */
const noDbContext = (): ToolContext => ({ db: {} as never, tenantId: 'test-tenant' });

describe('mcp-server adapter — declaration + error mapping (no DB)', () => {
  it('lists all 11 tools with correct annotations and object input schemas', async () => {
    const client = await connect(() => {
      throw new Error('handler must not run during listTools');
    });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);

    const balances = tools.find((t) => t.name === 'analytics_balances');
    expect(balances?.annotations?.readOnlyHint).toBe(true);
    expect(balances?.inputSchema.type).toBe('object');

    const track = tools.find((t) => t.name === 'ledger_track_wallet');
    expect(track?.annotations?.readOnlyHint).toBe(false);
    expect(track?.annotations?.destructiveHint).toBe(false);

    // Every description carries the mandatory untrusted-data sentence (contract §7).
    expect(tools.every((t) => t.description?.includes('untrusted'))).toBe(true);
  });

  it('maps an unknown tool name to a structured tool error', async () => {
    const client = await connect(noDbContext);
    const res = await client.callTool({ name: 'does_not_exist', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('maps a handler ToolError (bad input) to isError with a structured code (§4)', async () => {
    const client = await connect(noDbContext);
    // ledger_status validates its input before any DB access, so a bad payload
    // yields INVALID_INPUT without the dummy db ever being read.
    const res = await client.callTool({ name: 'ledger_status', arguments: { bogus: 1 } });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { code: string }).code).toBe('INVALID_INPUT');
  });
});
