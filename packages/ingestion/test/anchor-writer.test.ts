import { describe, expect, it } from 'vitest';
import { anchorTxHash, buildOpeningBalanceRows } from '../src/write/anchor-writer.js';

describe('anchorTxHash', () => {
  it('is the synthetic anchor:<addr>:<block> slot, lowercased (ADR-005)', () => {
    expect(anchorTxHash('0xAbCd01', 123)).toBe('anchor:0xabcd01:123');
  });
});

describe('buildOpeningBalanceRows', () => {
  const ADDR = '0xAAA0000000000000000000000000000000000001';
  const LOWER = ADDR.toLowerCase();

  it('credits the tracked address from the zero address at log_index -3', () => {
    const rows = buildOpeningBalanceRows({
      chainId: 1,
      address: ADDR,
      block: 100,
      blockTime: new Date('2024-01-01T00:00:00Z'),
      balances: [{ tokenId: 7, amountRaw: 5n, provider: 'blockscout' }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chainId: 1,
      txHash: `anchor:${LOWER}:100`,
      logIndex: -3,
      eventKind: 'opening_balance',
      tokenId: 7,
      amountRaw: 5n,
      // fold credits `to∈S`, so the wallet must be `to`; `from` is the (out-of-scope)
      // zero address — the mirror of gas_fee's `to=0x0`.
      fromAddr: '0x0000000000000000000000000000000000000000',
      toAddr: LOWER,
      blockNumber: 100,
      txFrom: '0x0000000000000000000000000000000000000000',
      txTo: LOWER,
      provider: 'blockscout',
    });
  });

  it('emits one row per token, all sharing the synthetic slot (token_id disambiguates)', () => {
    const rows = buildOpeningBalanceRows({
      chainId: 1,
      address: ADDR,
      block: 100,
      blockTime: new Date('2024-01-01T00:00:00Z'),
      balances: [
        { tokenId: 1, amountRaw: 5n, provider: 'blockscout' },
        { tokenId: 2, amountRaw: 9n, provider: 'blockscout' },
      ],
    });
    expect(rows.map((r) => r.tokenId)).toEqual([1, 2]);
    expect(new Set(rows.map((r) => r.txHash)).size).toBe(1);
    expect(new Set(rows.map((r) => r.logIndex))).toEqual(new Set([-3]));
  });
});
