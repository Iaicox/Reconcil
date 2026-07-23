import { describe, expect, it } from 'vitest';

import { anchorJobId, backfillJobId, probeJobId } from '../src/jobs.js';

describe('backfillJobId', () => {
  it('is a deterministic backfill:<chain>:<address>:<stream> id', () => {
    expect(backfillJobId(1, '0xabc', 'native')).toBe('backfill:1:0xabc:native');
    expect(backfillJobId(8453, '0xdef', 'erc20')).toBe('backfill:8453:0xdef:erc20');
  });

  it('lowercases the address so both producers agree regardless of case', () => {
    expect(backfillJobId(1, '0xABC', 'native')).toBe('backfill:1:0xabc:native');
  });
});

describe('anchorJobId', () => {
  it('is a deterministic anchor:<chain>:<address>:<stream> id, lowercased', () => {
    expect(anchorJobId(1, '0xABC', 'native')).toBe('anchor:1:0xabc:native');
    expect(anchorJobId(8453, '0xdef', 'erc20')).toBe('anchor:8453:0xdef:erc20');
  });
});

describe('probeJobId', () => {
  it('is a deterministic probe:<chain>:<address> id (per address, not per stream)', () => {
    expect(probeJobId(1, '0xABC')).toBe('probe:1:0xabc');
  });
});
