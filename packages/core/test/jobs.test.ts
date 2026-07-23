import { describe, expect, it } from 'vitest';

import { backfillJobId } from '../src/jobs.js';

describe('backfillJobId', () => {
  it('is a deterministic backfill:<chain>:<address>:<stream> id', () => {
    expect(backfillJobId(1, '0xabc', 'native')).toBe('backfill:1:0xabc:native');
    expect(backfillJobId(8453, '0xdef', 'erc20')).toBe('backfill:8453:0xdef:erc20');
  });

  it('lowercases the address so both producers agree regardless of case', () => {
    expect(backfillJobId(1, '0xABC', 'native')).toBe('backfill:1:0xabc:native');
  });
});
