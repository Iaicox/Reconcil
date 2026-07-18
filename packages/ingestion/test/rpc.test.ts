import { describe, expect, it, vi } from 'vitest';
import { rpcGetReceipts, type RpcCall } from '../src/providers/rpc.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

describe('rpcGetReceipts', () => {
  it('maps a JSON-RPC receipt result via the shared receipt schema', async () => {
    const rpc: RpcCall = vi.fn(async (method: string, params: unknown[]) => {
      expect(method).toBe('eth_getTransactionReceipt');
      expect(params).toEqual(['0xabc']);
      return {
        transactionHash: '0xABC', from: '0xEOA', to: '0xC',
        gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', status: '0x1', l1Fee: '0x0',
        logs: [{ logIndex: '0x0', address: '0xTok', topics: [TRANSFER, '0x1', '0x2'], data: '0x01' }],
      };
    });
    const [r] = await rpcGetReceipts(rpc, ['0xabc']);
    expect(r!.from).toBe('0xeoa');
    expect(r!.logs[0]!.logIndex).toBe(0);
  });
});
