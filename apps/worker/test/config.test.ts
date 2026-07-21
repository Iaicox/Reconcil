import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://u@localhost/db', REDIS_URL: 'redis://localhost:6379' };

describe('loadConfig', () => {
  it('accepts the compose-provided env and leaves optional keys undefined', () => {
    const cfg = loadConfig(base);
    expect(cfg.DATABASE_URL).toBe(base.DATABASE_URL);
    expect(cfg.ETHERSCAN_API_KEY).toBeUndefined();
  });

  it('rejects a missing DATABASE_URL loudly', () => {
    expect(() => loadConfig({ REDIS_URL: base.REDIS_URL })).toThrow();
  });
});
