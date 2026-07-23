import { describe, expect, it, vi } from 'vitest';
import { failoverProvider, buildProviderBundle } from '../src/providers/provider-factory.js';
import { ProviderError, type ChainDataProvider, type FetchJson } from '../src/types.js';

const stub = (over: Partial<ChainDataProvider>): ChainDataProvider => ({
  kind: 'etherscan-v2',
  getHead: async () => 1n,
  getNativeTxs: async () => ({ items: [] }),
  getErc20Transfers: async () => ({ items: [] }),
  ...over,
});

describe('failoverProvider', () => {
  it('falls through to the secondary on a ProviderError and reports the served kind', async () => {
    const primary = stub({ kind: 'etherscan-v2', getHead: async () => { throw new ProviderError('provider_error', 'no base'); } });
    const secondary = stub({ kind: 'blockscout', getHead: async () => 42n });
    const fp = failoverProvider([primary, secondary]);
    expect(await fp.getHead(8453)).toBe(42n);
    expect(fp.kind).toBe('blockscout');
  });

  it('rethrows when every provider fails', async () => {
    const boom = stub({ getHead: async () => { throw new ProviderError('http', 'HTTP 500'); } });
    await expect(failoverProvider([boom, boom]).getHead(1)).rejects.toThrow(ProviderError);
  });
});

describe('buildProviderBundle', () => {
  it('routes receipts to the injected RPC on receipts-opstack chains (base)', async () => {
    const rpcCall = vi.fn(async () => ({
      transactionHash: '0x1', from: '0xa', to: '0xb',
      gasUsed: '0x1', effectiveGasPrice: '0x1', status: '0x1', logs: [],
    }));
    const bundle = buildProviderBundle({
      chainId: 8453,
      env: { BASE_RPC_URL: 'https://rpc.example' },
      fetchJson: async () => ({ status: 200, body: {} }),
      rpcCallFor: () => rpcCall,
    });
    const [r] = await bundle.getReceipts(['0x1']);
    expect(r!.from).toBe('0xa');
    expect(rpcCall).toHaveBeenCalledOnce();
  });

  const ADDR = '0xabcd000000000000000000000000000000000001';
  // fetchJson that answers per etherscan-style `action` param.
  const byAction = (map: Record<string, unknown>): FetchJson => (url) => {
    const action = new URL(url).searchParams.get('action') ?? '';
    return Promise.resolve({ status: 200, body: map[action] ?? {} });
  };

  it('getBlockByTime resolves via etherscan on ethereum', async () => {
    const bundle = buildProviderBundle({
      chainId: 1,
      env: { ETHERSCAN_API_KEY: 'k' },
      fetchJson: byAction({ getblocknobytime: { status: '1', message: 'OK', result: '19000000' } }),
    });
    expect(await bundle.getBlockByTime(1700000000)).toBe(19000000n);
  });

  it('routes balance-at-block to blockscout (etherscan lacks the capability) and reports the served provider', async () => {
    const bundle = buildProviderBundle({
      chainId: 1,
      env: { ETHERSCAN_API_KEY: 'k' },
      fetchJson: byAction({
        eth_get_balance: { jsonrpc: '2.0', id: 0, result: '0xde0b6b3a7640000' }, // 1e18
        tokenbalance: { status: '1', message: 'OK', result: '2500000' },
      }),
    });
    const native = await bundle.getNativeBalanceAt(ADDR, 100n);
    expect(native).toEqual({ balance: 1000000000000000000n, provider: 'blockscout' });
    const erc20 = await bundle.getErc20BalanceAt(ADDR, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 100n);
    expect(erc20).toEqual({ balance: 2500000n, provider: 'blockscout' });
  });

  it('estimateTxCount reads the nonce via etherscan on ethereum', async () => {
    const bundle = buildProviderBundle({
      chainId: 1,
      env: { ETHERSCAN_API_KEY: 'k' },
      fetchJson: byAction({ eth_getTransactionCount: { jsonrpc: '2.0', id: 1, result: '0xc350' } }), // 50000
    });
    expect(await bundle.estimateTxCount(ADDR)).toBe(50000);
  });

  it('estimateTxCount degrades to undefined when no provider can serve it (base free tier)', async () => {
    const notSupported = { status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain.' };
    const bundle = buildProviderBundle({
      chainId: 8453,
      env: { ETHERSCAN_API_KEY: 'k', BASE_RPC_URL: 'https://rpc.example' },
      fetchJson: () => Promise.resolve({ status: 200, body: notSupported }),
    });
    expect(await bundle.estimateTxCount(ADDR)).toBeUndefined();
  });

  it('a required capability with no serving provider throws (explicit degradation, ADR-009)', async () => {
    const notSupported = { status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain.' };
    const bundle = buildProviderBundle({
      chainId: 8453,
      env: { ETHERSCAN_API_KEY: 'k', BASE_RPC_URL: 'https://rpc.example' },
      // both providers error → getBlockByTime cannot be served
      fetchJson: () => Promise.resolve({ status: 200, body: notSupported }),
    });
    await expect(bundle.getBlockByTime(1700000000)).rejects.toMatchObject({ name: 'ProviderError' });
  });
});
