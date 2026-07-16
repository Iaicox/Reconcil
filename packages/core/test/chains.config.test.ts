import { describe, expect, it } from 'vitest';
import { chainById, chains } from '../src/chains.config.js';

describe('chains.config', () => {
  it('has exactly ethereum(1) and base(8453)', () => {
    expect(chains.map((c) => c.chainId).sort()).toEqual([1, 8453]);
  });

  it('chain ids are unique', () => {
    expect(new Set(chains.map((c) => c.chainId)).size).toBe(chains.length);
  });

  it('fee strategies match 03-ingestion §6', () => {
    expect(chainById(1).feeStrategy).toBe('txlist');
    expect(chainById(8453).feeStrategy).toBe('receipts-opstack');
  });

  it('every chain lists etherscan-v2 first, blockscout second', () => {
    for (const c of chains) {
      expect(c.providers.map((p) => p.kind)).toEqual(['etherscan-v2', 'blockscout']);
      expect(c.providers[0]?.apiKeyEnv).toBe('ETHERSCAN_API_KEY');
      expect(c.providers[1]?.apiKeyEnv).toBeUndefined();
    }
  });

  it('finality depths are per-chain config (ADR-005)', () => {
    expect(chainById(1).finalityDepth).toBe(64n);
    expect(chainById(8453).finalityDepth).toBe(600n);
  });

  it('chainById throws on unknown chain', () => {
    expect(() => chainById(999)).toThrow(/unknown chain/i);
  });
});
