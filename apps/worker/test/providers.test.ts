import { describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from '../src/config.js';
import { buildChainBundle, buildPriceBundle, providerEnvFrom } from '../src/providers.js';

const cfg: WorkerConfig = {
  DATABASE_URL: 'postgres://u@localhost/db',
  REDIS_URL: 'redis://localhost:6379',
  ETHERSCAN_API_KEY: 'esk-1',
  BASE_RPC_URL: 'https://base.example',
  COINGECKO_API_KEY: 'cgk-1',
};

// H15 minor: loadConfig() validates these three keys, but main.ts previously
// passed `env: process.env` straight through — the schema was decorative. The
// env record every provider factory reads must be built FROM cfg, not process.env.
describe('providerEnvFrom', () => {
  it('carries exactly the keys providers read, from cfg', () => {
    expect(providerEnvFrom(cfg)).toEqual({
      ETHERSCAN_API_KEY: 'esk-1',
      BASE_RPC_URL: 'https://base.example',
      COINGECKO_API_KEY: 'cgk-1',
    });
  });

  it('carries through undefined for unset optional keys (no process.env fallback)', () => {
    const bare: WorkerConfig = { DATABASE_URL: cfg.DATABASE_URL, REDIS_URL: cfg.REDIS_URL };
    expect(providerEnvFrom(bare)).toEqual({
      ETHERSCAN_API_KEY: undefined,
      BASE_RPC_URL: undefined,
      COINGECKO_API_KEY: undefined,
    });
  });
});

describe('buildChainBundle', () => {
  it('calls buildProviderBundle with the cfg-derived env, not process.env', () => {
    const fakeBundle = { marker: 'bundle' };
    const build = vi.fn().mockReturnValue(fakeBundle);
    const fetchJson = vi.fn();

    const out = buildChainBundle(cfg, 1, fetchJson, build as never);

    expect(build).toHaveBeenCalledWith({ chainId: 1, env: providerEnvFrom(cfg), fetchJson });
    expect(out).toBe(fakeBundle);
  });
});

describe('buildPriceBundle', () => {
  it('calls buildPriceProviderBundle with the cfg-derived env, not process.env', () => {
    const fakeBundle = { marker: 'price-bundle' };
    const build = vi.fn().mockReturnValue(fakeBundle);
    const fetchJson = vi.fn();

    const out = buildPriceBundle(cfg, fetchJson, build as never);

    expect(build).toHaveBeenCalledWith({ env: providerEnvFrom(cfg), fetchJson });
    expect(out).toBe(fakeBundle);
  });
});
