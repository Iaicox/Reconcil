import { chainEvents, createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { fxDateRange, priceGaps } from '../src/gaps.js';
import { materializePegSnapshots, upsertFxRates, upsertSnapshots } from '../src/snapshot-service.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let seq = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
}, 120_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => {
  await pool.query('TRUNCATE chain_events, price_snapshots, fx_rates, tokens RESTART IDENTITY CASCADE');
  seq = 0;
});

const EXT = '0x00000000000000000000000000000000000000e1';
const OWNED = '0x00000000000000000000000000000000000000a1';
const addr = (id: number): string => `0x${id.toString(16).padStart(40, '0')}`;

async function seedToken(
  id: number,
  over: { isStablecoin?: boolean; pegCurrency?: string | null; verified?: boolean; coingeckoId?: string | null } = {},
): Promise<void> {
  const { isStablecoin = false, pegCurrency = null, verified = true, coingeckoId = null } = over;
  await pool.query(
    `INSERT INTO tokens (id, chain_id, address, standard, decimals, is_stablecoin, peg_currency, verified, coingecko_id, symbol_display)
     OVERRIDING SYSTEM VALUE VALUES ($1,1,$2,'erc20',18,$3,$4,$5,$6,$7)`,
    [id, addr(id), isStablecoin, pegCurrency, verified, coingeckoId, `T${String(id)}`],
  );
}

async function seedEvent(tokenId: number, date: string): Promise<void> {
  seq += 1;
  await db.insert(chainEvents).values({
    chainId: 1, txHash: `0x${seq.toString(16).padStart(64, '0')}`, logIndex: 0, eventKind: 'erc20_transfer',
    tokenId, amountRaw: 1n, fromAddr: EXT, toAddr: OWNED, blockNumber: seq,
    blockTime: new Date(`${date}T12:00:00Z`), txFrom: EXT, txTo: OWNED, provider: 'fixture', raw: {},
  });
}

describe('priceGaps — verified (token, date) closes not yet priced', () => {
  it('lists distinct verified token-dates and excludes unverified and already-priced', async () => {
    await seedToken(1);
    await seedToken(2);
    await seedToken(3, { verified: false }); // spam — excluded
    await seedEvent(1, '2026-06-01');
    await seedEvent(1, '2026-06-01'); // same key → one gap
    await seedEvent(1, '2026-06-02');
    await seedEvent(2, '2026-06-01');
    await seedEvent(3, '2026-06-01');
    // token 2 on 06-01 is already priced → not a gap
    await upsertSnapshots(db, [{ tokenId: 2, priceDate: '2026-06-01', currency: 'USD', price: '1', source: 'defillama' }]);

    const gaps = await priceGaps(db);
    const keys = gaps.map((g) => `${String(g.tokenId)}|${g.date}`).sort();
    expect(keys).toEqual(['1|2026-06-01', '1|2026-06-02']);
  });

  it('a peg row does not satisfy a market-price gap', async () => {
    await seedToken(5, { isStablecoin: true, pegCurrency: 'USD' });
    await seedEvent(5, '2026-06-01');
    await upsertSnapshots(db, [{ tokenId: 5, priceDate: '2026-06-01', currency: 'USD', price: '1', source: 'peg' }]);
    expect(priceGaps(db).then((g) => g.map((x) => x.tokenId))).resolves.toEqual([5]);
  });
});

describe('fxDateRange', () => {
  it('spans min−7d … max of activity dates', async () => {
    await seedToken(1);
    await seedEvent(1, '2026-06-10');
    await seedEvent(1, '2026-06-15');
    expect(await fxDateRange(db)).toEqual({ from: '2026-06-03', to: '2026-06-15' });
  });

  it('is null with no events', async () => {
    expect(await fxDateRange(db)).toBeNull();
  });
});

describe('append-only upserts are idempotent', () => {
  it('re-inserting the same snapshot/FX rows inserts nothing new', async () => {
    await seedToken(1);
    const snap = [{ tokenId: 1, priceDate: '2026-06-01', currency: 'USD', price: '2000', source: 'defillama' }];
    expect(await upsertSnapshots(db, snap)).toBe(1);
    expect(await upsertSnapshots(db, snap)).toBe(0);

    const fx = [{ rateDate: '2026-06-01', baseCurrency: 'EUR', quoteCurrency: 'USD', rate: '1.08', source: 'ecb' }];
    expect(await upsertFxRates(db, fx)).toBe(1);
    expect(await upsertFxRates(db, fx)).toBe(0);
  });
});

describe('upsertSnapshots — batches larger than the 65535 bind-param cap', () => {
  it('chunks a >13k-row insert instead of failing on the param limit', async () => {
    await seedToken(1);
    const rows = [];
    const base = Date.UTC(2000, 0, 1);
    for (let i = 0; i < 14000; i++) { // 14000 × 5 params = 70000 > 65535
      const d = new Date(base + i * 86_400_000).toISOString().slice(0, 10);
      rows.push({ tokenId: 1, priceDate: d, currency: 'USD', price: '1', source: 'defillama' });
    }
    expect(await upsertSnapshots(db, rows)).toBe(14000);
  });
});

describe('materializePegSnapshots', () => {
  it('creates one peg row per stablecoin activity date, idempotently', async () => {
    await seedToken(1); // not a stablecoin → no peg row
    await seedToken(5, { isStablecoin: true, pegCurrency: 'USD' });
    await seedEvent(1, '2026-06-01');
    await seedEvent(5, '2026-06-01');
    await seedEvent(5, '2026-06-02');

    expect(await materializePegSnapshots(db)).toBe(2);
    expect(await materializePegSnapshots(db)).toBe(0); // idempotent

    const { rows } = await pool.query(
      `SELECT token_id, price_date::text, currency, price, source FROM price_snapshots ORDER BY price_date`,
    );
    expect(rows).toEqual([
      { token_id: '5', price_date: '2026-06-01', currency: 'USD', price: '1', source: 'peg' },
      { token_id: '5', price_date: '2026-06-02', currency: 'USD', price: '1', source: 'peg' },
    ]);
  });
});
