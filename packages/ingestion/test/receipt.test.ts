import { describe, expect, it } from 'vitest';
import { mapReceipt, receiptResult } from '../src/providers/etherscan-v2.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

describe('mapReceipt with logs', () => {
  it('maps from/to and decodes hex logIndex, lowercasing addresses', () => {
    const raw = receiptResult.parse({
      transactionHash: '0xABC',
      from: '0xFromEOA',
      to: '0xToContract',
      gasUsed: '0x5208',
      effectiveGasPrice: '0x3b9aca00',
      status: '0x1',
      l1Fee: '0x64',
      logs: [
        { logIndex: '0x2', address: '0xTokenC', topics: [TRANSFER, '0x1', '0x2'], data: '0x0a' },
      ],
    });
    const r = mapReceipt(raw);
    expect(r.transactionHash).toBe('0xabc');
    expect(r.from).toBe('0xfromeoa');
    expect(r.to).toBe('0xtocontract');
    expect(r.l1Fee).toBe('100');
    expect(r.logs).toEqual([
      { logIndex: 2, address: '0xtokenc', topics: [TRANSFER, '0x1', '0x2'], data: '0x0a' },
    ]);
  });

  it('accepts a null tx-level to (contract creation) and an empty logs array', () => {
    const r = mapReceipt(
      receiptResult.parse({
        transactionHash: '0xdef', from: '0xa', to: null,
        gasUsed: '0x1', effectiveGasPrice: '0x1', status: '0x1', logs: [],
      }),
    );
    expect(r.to).toBeNull();
    expect(r.logs).toEqual([]);
  });
});
