/**
 * `hydratePriceRefs` / `hydrateFxRefs` ordering (H11, C4).
 *
 * Both return a `Map`, and both callers turn it straight into the envelope's citation
 * ARRAY (`[...priceRefMap.values()]` in export-journal-drafts.ts). A `Map` iterates in
 * insertion order, insertion order is SQL row order, and SQL row order without `ORDER BY`
 * is whatever the planner felt like — so the same tool call could emit its citations in a
 * different order on two runs over identical data. That is a determinism defect (P1/P2),
 * not a correctness one: the refs attach to legs by id either way.
 *
 * These tests pin the order to ascending id. They do not try to PROVOKE the old
 * instability — a seq scan on a handful of rows usually comes back sorted anyway, so a
 * test that waited for the planner to misbehave would pass vacuously. Asserting the
 * contract is what makes a future `ORDER BY` removal fail.
 */
import { createDb, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hydrateFxRefs, hydratePriceRefs } from '../src/pricing-refs.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

const TOKEN = `0x${'e'.repeat(40)}`;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  // See export-journal-drafts.itest.ts: a Pool with no 'error' listener turns the
  // container's shutdown notice (57P01) into an unhandled error that reds the whole run.
  pool.on('error', () => { /* expected while the container is torn down */ });
  await runMigrations(pool);
  db = createDb(pool);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

async function seedToken(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tokens (chain_id, address, standard, symbol_display, decimals, is_stablecoin, peg_currency, verified)
     VALUES (1, $1, 'erc20', 'WETH', 18, false, null, true) RETURNING id`,
    [TOKEN],
  );
  return Number(rows[0]!.id);
}

describe('pricing ref hydration is run-stable', () => {
  it('returns price refs in ascending snapshot id, whatever order the ids were asked for', async () => {
    const tokenId = await seedToken();
    const ids: number[] = [];
    for (const [date, price] of [['2026-06-01', '1000'], ['2026-06-02', '1100'], ['2026-06-03', '1200'], ['2026-06-04', '1300']] as const) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO price_snapshots (token_id, price_date, currency, price, source)
         VALUES ($1,$2,'EUR',$3,'defillama') RETURNING id`,
        [tokenId, date, price],
      );
      ids.push(Number(rows[0]!.id));
    }

    const sorted = [...ids].sort((a, b) => a - b);
    // Asked for shuffled — the result must not depend on the caller's id order either.
    const map = await hydratePriceRefs(db, [ids[2]!, ids[0]!, ids[3]!, ids[1]!]);
    expect([...map.keys()]).toEqual(sorted);
    expect([...map.values()].map((r) => r.snapshot_id)).toEqual(sorted);
  });

  it('returns fx refs in ascending fx_rate id', async () => {
    const ids: number[] = [];
    for (const date of ['2026-06-01', '2026-06-02', '2026-06-03']) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO fx_rates (rate_date, base_currency, quote_currency, rate, source)
         VALUES ($1,'USD','EUR','0.92','ecb') RETURNING id`,
        [date],
      );
      ids.push(Number(rows[0]!.id));
    }

    const sorted = [...ids].sort((a, b) => a - b);
    const map = await hydrateFxRefs(db, [ids[1]!, ids[2]!, ids[0]!]);
    expect([...map.keys()]).toEqual(sorted);
    expect([...map.values()].map((r) => r.fx_rate_id)).toEqual(sorted);
  });

  it('short-circuits an empty id list without a query', async () => {
    expect((await hydratePriceRefs(db, [])).size).toBe(0);
    expect((await hydrateFxRefs(db, [])).size).toBe(0);
  });
});
