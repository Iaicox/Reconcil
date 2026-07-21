import { describe, expect, it } from 'vitest';
import { assignErc20Metadata } from '../src/logindex.js';
import type { RawErc20Transfer, RawReceipt } from '../src/types.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (addr: string): string => '0x' + addr.slice(2).padStart(64, '0');
const val = (n: bigint): string => '0x' + n.toString(16);
// Full 20-byte (40-hex) addresses: a real address survives pad()→topicAddr()
// round-trip (topicAddr takes the low 20 bytes). Short stubs like '0xaaa' would
// not — topicAddr('0x00…00aaa') is '0x00…00aaa', never '0xaaa'.
const AAA = '0x' + 'a'.repeat(40);
const BBB = '0x' + 'b'.repeat(40);

const row = (over: Partial<RawErc20Transfer>): RawErc20Transfer => ({
  blockNumber: '100', timeStamp: '1700000000', hash: '0xtx', logIndex: null,
  from: AAA, to: BBB, contractAddress: '0xtok', value: '5',
  tokenName: 'T', tokenSymbol: 'T', tokenDecimal: '18', ...over,
});

const receipt = (logs: RawReceipt['logs']): RawReceipt => ({
  transactionHash: '0xtx', from: '0xsender', to: '0xrouter',
  gasUsed: '1', effectiveGasPrice: '1', l1Fee: null, status: '1', logs,
});

describe('assignErc20Metadata', () => {
  it('assigns the matching log index and tx-level from/to', () => {
    const rec = receipt([
      { logIndex: 7, address: '0xtok', topics: [TRANSFER, pad(AAA), pad(BBB)], data: val(5n) },
    ]);
    const [out] = assignErc20Metadata([row({})], new Map([['0xtx', rec]]));
    expect(out!.logIndex).toBe('7');
    expect(out!.txFrom).toBe('0xsender');
    expect(out!.txTo).toBe('0xrouter');
  });

  it('gives duplicate identical transfers distinct indexes in ascending order', () => {
    const rec = receipt([
      { logIndex: 9, address: '0xtok', topics: [TRANSFER, pad(AAA), pad(BBB)], data: val(5n) },
      { logIndex: 4, address: '0xtok', topics: [TRANSFER, pad(AAA), pad(BBB)], data: val(5n) },
    ]);
    const out = assignErc20Metadata([row({}), row({})], new Map([['0xtx', rec]]));
    expect(out.map((r) => r.logIndex).sort()).toEqual(['4', '9']);
  });

  it('ignores ERC-721 Transfer logs (4 topics)', () => {
    const rec = receipt([
      { logIndex: 1, address: '0xtok', topics: [TRANSFER, pad(AAA), pad(BBB), pad('0x01')], data: '0x' },
      { logIndex: 2, address: '0xtok', topics: [TRANSFER, pad(AAA), pad(BBB)], data: val(5n) },
    ]);
    const [out] = assignErc20Metadata([row({})], new Map([['0xtx', rec]]));
    expect(out!.logIndex).toBe('2');
  });

  it('throws when the receipt is missing', () => {
    expect(() => assignErc20Metadata([row({})], new Map())).toThrow(/receipt/i);
  });

  it('throws when no log matches the transfer', () => {
    const rec = receipt([{ logIndex: 0, address: '0xother', topics: [TRANSFER, pad(AAA), pad(BBB)], data: val(5n) }]);
    expect(() => assignErc20Metadata([row({})], new Map([['0xtx', rec]]))).toThrow(/no matching/i);
  });
});
