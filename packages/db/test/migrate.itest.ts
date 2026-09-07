import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';

describe('runMigrations', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('creates the schema on a fresh database', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toContain('chain_events');
    expect(names).toContain('ingestion_checkpoints');
    expect(names).toContain('tokens');
  });

  it('is idempotent — a second run is a no-op', async () => {
    await expect(runMigrations(pool)).resolves.toBeUndefined();
  });
});

// H1 remediation (docs/architecture/03-ingestion.md §7): a curated seed of natives +
// USDC/USDT/DAI/WETH ships verified = true as a db migration, so a fresh deployment
// isn't empty everywhere (analytics tools default include_unverified=false, priceGaps
// defaults verifiedOnly=true, etc.). Spot-check Ethereum's native + USDC rows — the
// migration ran once already in the describe block above (same container, no truncation
// in this file), so these assert on the real migration output, not a synthetic fixture.
describe('curated token seed (migration 0002)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('seeds the Ethereum native pseudo-token as verified with a non-null symbol_display', async () => {
    const { rows } = await pool.query(
      `SELECT standard, decimals, verified, symbol_display, name_display, is_stablecoin, peg_currency
       FROM tokens WHERE chain_id = 1 AND address IS NULL`,
    );
    expect(rows).toEqual([
      { standard: 'native', decimals: 18, verified: true, symbol_display: 'ETH', name_display: 'ETH', is_stablecoin: false, peg_currency: null },
    ]);
  });

  it('seeds Ethereum USDC as verified with is_stablecoin/peg_currency and a non-null symbol_display', async () => {
    const { rows } = await pool.query(
      `SELECT standard, decimals, verified, symbol_display, is_stablecoin, peg_currency
       FROM tokens WHERE chain_id = 1 AND address = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'`,
    );
    expect(rows).toEqual([
      { standard: 'erc20', decimals: 6, verified: true, symbol_display: 'USDC', is_stablecoin: true, peg_currency: 'USD' },
    ]);
  });

  it('seeds all 5 curated tokens (native, USDC, USDT, DAI, WETH) for both configured chains, all verified', async () => {
    const { rows } = await pool.query(
      `SELECT chain_id, count(*)::int AS n FROM tokens WHERE verified = true GROUP BY chain_id ORDER BY chain_id`,
    );
    expect(rows).toEqual([
      { chain_id: 1, n: 5 },
      { chain_id: 8453, n: 5 },
    ]);
  });

  it('is idempotent — re-running migrations does not duplicate the seeded rows', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM tokens WHERE verified = true');
    expect(rows[0].n).toBe(10);
  });
});
