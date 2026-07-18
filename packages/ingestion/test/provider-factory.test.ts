import { describe, expect, it, vi } from 'vitest';
import { failoverProvider, buildProviderBundle } from '../src/providers/provider-factory.js';
import { ProviderError, type ChainDataProvider } from '../src/types.js';

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
});
