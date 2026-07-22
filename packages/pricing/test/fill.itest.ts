import { chainEvents, createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runPriceFill } from '../src/fill.js';
import type { PriceBundle, PriceProvider } from '../src/providers/types.js';
import type { ValueNeed } from '../src/types.js';
import { valueQuantities } from '../src/value.js';

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

async function seedToken(id: number, over: { isStablecoin?: boolean; pegCurrency?: string | null } = {}): Promise<void> {
  const { isStablecoin = false, pegCurrency = null } = over;
  await pool.query(
    `INSERT INTO tokens (id, chain_id, address, standard, decimals, is_stablecoin, peg_currency, verified, symbol_display)
     OVERRIDING SYSTEM VALUE VALUES ($1,1,$2,'erc20',18,$3,$4,true,$5)`,
    [id, addr(id), isStablecoin, pegCurrency, `T${String(id)}`],
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

/** A DefiLlama-shaped stub keyed by `${chainSlug}:${address}|${date}`. */
function stubBundle(prices: Record<string, string>): PriceBundle {
  const price: PriceProvider = {
    source: 'defillama',
    dailyPrice: (q) => {
      const key = `${q.chainSlug}:${(q.address ?? '').toLowerCase()}|${q.date}`;
      const p = prices[key];
      return Promise.resolve(p === undefined ? null : { price: p, currency: 'USD' });
    },
  };
  return {
    price: [price],
    fx: { source: 'ecb', rangeRates: () => Promise.resolve([{ date: '2026-06-01', quote: 'USD', rate: '1.08' }]) },
  };
}

const need = (o: Partial<ValueNeed> & Pick<ValueNeed, 'tokenId' | 'amount' | 'date'>): ValueNeed =>
  ({ isStablecoin: false, pegCurrency: null, ...o } as ValueNeed);

describe('runPriceFill — gaps → fetch → append, then valuation reads it', () => {
  it('fills market snapshots + FX, is idempotent, and feeds valueQuantities end-to-end', async () => {
    await seedToken(1);
    await seedEvent(1, '2026-06-01');
    const bundle = stubBundle({ [`ethereum:${addr(1)}|2026-06-01`]: '2000' });

    const first = await runPriceFill({ db, bundle });
    expect(first).toMatchObject({ gaps: 1, pricesInserted: 1, fxInserted: 1 });
    // Re-run: nothing new (append-only idempotency).
    expect(await runPriceFill({ db, bundle })).toMatchObject({ pricesInserted: 0, fxInserted: 0, gaps: 0 });

    const usd = await valueQuantities(db, [need({ tokenId: 1, amount: '3' as ValueNeed['amount'], date: '2026-06-01' })], { currency: 'USD' });
    expect(usd.values[0]?.fiatValue).toBe('6000');
    const eur = await valueQuantities(db, [need({ tokenId: 1, amount: '3' as ValueNeed['amount'], date: '2026-06-01' })], { currency: 'EUR' });
    expect(eur.values[0]?.fiatValue?.startsWith('5555.5555')).toBe(true); // 6000 / 1.08
    expect(eur.fxRefs).toHaveLength(1);
  });

  it('a throwing provider for one token does not abort the batch', async () => {
    await seedToken(1);
    await seedToken(2);
    await seedEvent(1, '2026-06-01'); // provider throws for this token
    await seedEvent(2, '2026-06-01'); // this one prices fine
    const bundle: PriceBundle = {
      price: [{
        source: 'defillama',
        dailyPrice: (q) => {
          if ((q.address ?? '').toLowerCase() === addr(1)) return Promise.reject(new Error('network boom'));
          return Promise.resolve({ price: '3000', currency: 'USD' });
        },
      }],
      fx: { source: 'ecb', rangeRates: () => Promise.resolve([]) },
    };

    // Must resolve (not reject) and still have inserted token 2's snapshot.
    const res = await runPriceFill({ db, bundle });
    expect(res.pricesInserted).toBe(1);
    const usd = await valueQuantities(db, [need({ tokenId: 2, amount: '2' as ValueNeed['amount'], date: '2026-06-01' })], { currency: 'USD' });
    expect(usd.values[0]?.fiatValue).toBe('6000');
  });

  it('materializes peg snapshots for stablecoins during the fill', async () => {
    await seedToken(5, { isStablecoin: true, pegCurrency: 'USD' });
    await seedEvent(5, '2026-06-01');
    const res = await runPriceFill({ db, bundle: stubBundle({}) });
    expect(res.pegInserted).toBe(1);

    const peg = await valueQuantities(
      db, [need({ tokenId: 5, amount: '100' as ValueNeed['amount'], date: '2026-06-01', isStablecoin: true, pegCurrency: 'USD' })],
      { currency: 'USD', policy: 'peg_for_stables' },
    );
    expect(peg.values[0]?.fiatValue).toBe('100');
    expect(peg.priceRefs[0]?.source).toBe('peg');
  });
});
