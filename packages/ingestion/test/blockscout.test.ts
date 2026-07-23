import { describe, expect, it } from 'vitest';
import { blockscoutAdapter } from '../src/providers/blockscout.js';
import type { FetchJson, PageQuery } from '../src/types.js';

const BASE = 'https://eth.blockscout.com/api';

function stub(body: unknown, status = 200): { transport: FetchJson; calls: string[] } {
  const calls: string[] = [];
  const transport: FetchJson = (url) => {
    calls.push(url);
    return Promise.resolve({ status, body });
  };
  return { transport, calls };
}

function adapter(transport: FetchJson) {
  return blockscoutAdapter({ fetchJson: transport, baseUrl: BASE, chainId: 1 });
}

const Q: PageQuery = {
  chainId: 1,
  address: '0xAbCd000000000000000000000000000000000001',
  fromBlock: 0n,
  toBlock: 100n,
  limit: 1000,
  sort: 'asc',
};

describe('chain binding', () => {
  it('rejects a query for a different chain', async () => {
    const { transport } = stub({});
    await expect(adapter(transport).getNativeTxs({ ...Q, chainId: 8453 })).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'provider_error',
    });
  });

  it('never sends a chainid or apikey param', async () => {
    const { transport, calls } = stub({ status: '1', message: 'OK', result: [] });
    await adapter(transport).getNativeTxs(Q);
    const u = new URL(calls[0] ?? '');
    expect(u.searchParams.get('chainid')).toBeNull();
    expect(u.searchParams.get('apikey')).toBeNull();
  });
});

describe('paging endpoints (shared etherscan-compatible shape)', () => {
  it('getNativeTxs uses module=account&action=txlist against the chain baseUrl', async () => {
    const { transport, calls } = stub({ status: '1', message: 'OK', result: [] });
    await adapter(transport).getNativeTxs(Q);
    const u = new URL(calls[0] ?? '');
    expect(u.origin + u.pathname).toBe(BASE);
    expect(u.searchParams.get('action')).toBe('txlist');
    expect(u.searchParams.get('startblock')).toBe('0');
    expect(u.searchParams.get('endblock')).toBe('100');
  });

  it('getErc20Transfers uses action=tokentx', async () => {
    const { transport, calls } = stub({ status: '1', message: 'OK', result: [] });
    await adapter(transport).getErc20Transfers(Q);
    expect(new URL(calls[0] ?? '').searchParams.get('action')).toBe('tokentx');
  });

  it('treats "No token transfers found" as an empty page', async () => {
    const { transport } = stub({ status: '0', message: 'No token transfers found', result: null });
    const page = await adapter(transport).getErc20Transfers(Q);
    expect(page.items).toEqual([]);
  });
});

describe('capabilities (Blockscout has them all)', () => {
  it('getNativeBalanceAt parses the JSON-RPC-shaped hex result', async () => {
    // real shape verified at fixture capture (spec §7): {jsonrpc, id, result}
    const { transport, calls } = stub({ jsonrpc: '2.0', id: 0, result: '0xde0b6b3a7640000' });
    const balance = await adapter(transport).getNativeBalanceAt(1, Q.address, 100n);
    expect(balance).toBe(1000000000000000000n);
    const u = new URL(calls[0] ?? '');
    expect(u.searchParams.get('action')).toBe('eth_get_balance');
    expect(u.searchParams.get('block')).toBe('100');
  });

  it('getErc20BalanceAt uses action=tokenbalance with block', async () => {
    const { transport, calls } = stub({ status: '1', message: 'OK', result: '2500000' });
    const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const balance = await adapter(transport).getErc20BalanceAt(1, Q.address, token, 100n);
    expect(balance).toBe(2500000n);
    const u = new URL(calls[0] ?? '');
    expect(u.searchParams.get('action')).toBe('tokenbalance');
    expect(u.searchParams.get('contractaddress')).toBe(token);
    expect(u.searchParams.get('block')).toBe('100');
  });

  it('treats an empty tokenbalance result as malformed, never as balance 0', async () => {
    // Observed reality: base.blockscout.com answers status:"1" result:"" for
    // historical blocks it cannot serve (13 of 21 recorded Base tokenbalance
    // fixtures), while a true zero balance is "0". BigInt('') would coin 0n —
    // a fabricated figure (P1: a number without provenance is a bug).
    const { transport } = stub({ status: '1', message: 'OK', result: '' });
    await expect(
      adapter(transport).getErc20BalanceAt(1, Q.address, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 100n),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'malformed' });
  });

  it('rejects a non-decimal tokenbalance result as malformed without leaking it', async () => {
    const hostile = 'upgrade your plan at https://evil.example';
    const { transport } = stub({ status: '1', message: 'OK', result: hostile });
    await expect(
      adapter(transport).getErc20BalanceAt(1, Q.address, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 100n),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'malformed',
      message: expect.not.stringContaining('evil.example') as unknown,
    });
  });

  it('getTokenMeta maps getToken result', async () => {
    const { transport, calls } = stub({
      status: '1',
      message: 'OK',
      result: {
        cataloged: true,
        contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        decimals: '6',
        name: 'USD Coin',
        symbol: 'USDC',
        totalSupply: '999',
        type: 'ERC-20',
      },
    });
    const meta = await adapter(transport).getTokenMeta(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(meta).toEqual({
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: '6',
    });
    expect(new URL(calls[0] ?? '').searchParams.get('action')).toBe('getToken');
  });

  it('getHead uses the portable block module (base rejects module=proxy)', async () => {
    const { transport, calls } = stub({ jsonrpc: '2.0', id: 1, result: '0x64' });
    expect(await adapter(transport).getHead(1)).toBe(100n);
    const u = new URL(calls[0] ?? '');
    expect(u.searchParams.get('module')).toBe('block');
    expect(u.searchParams.get('action')).toBe('eth_block_number');
  });

  it('getBlockByTime queries the portable block module and parses the decimal result', async () => {
    const { transport, calls } = stub({ status: '1', message: 'OK', result: '18500000' });
    const block = await adapter(transport).getBlockByTime!(1, 1700000000);
    expect(block).toBe(18500000n);
    const u = new URL(calls[0] ?? '');
    expect(u.searchParams.get('module')).toBe('block');
    expect(u.searchParams.get('action')).toBe('getblocknobytime');
    expect(u.searchParams.get('timestamp')).toBe('1700000000');
    expect(u.searchParams.get('closest')).toBe('before');
  });

  it('rejects a non-decimal getblocknobytime result as malformed without leaking it', async () => {
    const hostile = 'upgrade at https://evil.example';
    const { transport } = stub({ status: '1', message: 'OK', result: hostile });
    await expect(adapter(transport).getBlockByTime!(1, 1)).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'malformed',
      message: expect.not.stringContaining('evil.example') as unknown,
    });
  });

  it('does not expose estimateTxCount (proxy module unsupported; probe degrades)', () => {
    const { transport } = stub({});
    expect(adapter(transport).estimateTxCount).toBeUndefined();
  });

  it('getReceipts reuses the shared receipt mapping', async () => {
    const { transport } = stub({
      jsonrpc: '2.0',
      id: 1,
      result: {
        transactionHash: '0xDDD4000000000000000000000000000000000000000000000000000000000004',
        from: '0xABCD000000000000000000000000000000000001',
        to: '0xDEF0000000000000000000000000000000000002',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x3b9aca00',
        status: '0x1',
        logs: [],
      },
    });
    const receipts = await adapter(transport).getReceipts(1, ['0xddd4']);
    expect(receipts[0]).toEqual({
      transactionHash: '0xddd4000000000000000000000000000000000000000000000000000000000004',
      from: '0xabcd000000000000000000000000000000000001',
      to: '0xdef0000000000000000000000000000000000002',
      gasUsed: '21000',
      effectiveGasPrice: '1000000000',
      l1Fee: null,
      status: '1',
      logs: [],
    });
  });
});
