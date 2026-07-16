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
  it('getNativeBalanceAt parses hex or decimal result', async () => {
    const { transport, calls } = stub({ status: '1', message: 'OK', result: '0xde0b6b3a7640000' });
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

  it('getHead parses proxy eth_blockNumber', async () => {
    const { transport } = stub({ jsonrpc: '2.0', id: 1, result: '0x64' });
    expect(await adapter(transport).getHead(1)).toBe(100n);
  });

  it('getReceipts reuses the shared receipt mapping', async () => {
    const { transport } = stub({
      jsonrpc: '2.0',
      id: 1,
      result: {
        transactionHash: '0xDDD4000000000000000000000000000000000000000000000000000000000004',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x3b9aca00',
        status: '0x1',
      },
    });
    const receipts = await adapter(transport).getReceipts(1, ['0xddd4']);
    expect(receipts[0]).toEqual({
      transactionHash: '0xddd4000000000000000000000000000000000000000000000000000000000004',
      gasUsed: '21000',
      effectiveGasPrice: '1000000000',
      l1Fee: null,
      status: '1',
    });
  });
});
