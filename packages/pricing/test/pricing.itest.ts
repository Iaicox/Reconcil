import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DecimalString } from '@pet-crypto/core';

import type { ValueNeed } from '../src/types.js';
import { valueQuantities } from '../src/value.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
}, 120_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => {
  await pool.query('TRUNCATE price_snapshots, fx_rates, tokens RESTART IDENTITY CASCADE');
});

const addr = (id: number): string => `0x${id.toString(16).padStart(40, '0')}`;

async function seedToken(
  id: number,
  over: { decimals?: number; isStablecoin?: boolean; pegCurrency?: string | null; symbol?: string } = {},
): Promise<void> {
  const { decimals = 18, isStablecoin = false, pegCurrency = null, symbol = `T${String(id)}` } = over;
  await pool.query(
    `INSERT INTO tokens (id, chain_id, address, standard, decimals, is_stablecoin, peg_currency, verified, symbol_display)
     OVERRIDING SYSTEM VALUE VALUES ($1,1,$2,'erc20',$3,$4,$5,true,$6)`,
    [id, addr(id), decimals, isStablecoin, pegCurrency, symbol],
  );
}

async function seedSnapshot(
  s: { tokenId: number; date: string; price: string; source: string; currency?: string },
): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO price_snapshots (token_id, price_date, currency, price, source)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [s.tokenId, s.date, s.currency ?? 'USD', s.price, s.source],
  );
  return Number((rows[0] as { id: string }).id); // pg returns int8 as string; prod path uses numbers
}

async function seedFx(f: { date: string; rate: string; base?: string; quote?: string }): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO fx_rates (rate_date, base_currency, quote_currency, rate, source)
     VALUES ($1,$2,$3,$4,'ecb') RETURNING id`,
    [f.date, f.base ?? 'EUR', f.quote ?? 'USD', f.rate],
  );
  return Number((rows[0] as { id: string }).id);
}

const need = (o: Partial<ValueNeed> & Pick<ValueNeed, 'tokenId' | 'amount'>): ValueNeed =>
  ({ date: '2026-06-01', isStablecoin: false, pegCurrency: null, ...o });
const ds = (s: string): DecimalString => s as DecimalString;

describe('valueQuantities — fiat with pinned refs (C4), warnings, dedup', () => {
  it('values in USD at market with one price ref, no FX', async () => {
    await seedToken(1, { symbol: 'ETH' });
    await seedSnapshot({ tokenId: 1, date: '2026-06-01', price: '2000', source: 'defillama' });

    const res = await valueQuantities(db, [need({ tokenId: 1, amount: ds('10'), symbol: 'ETH' })], { currency: 'USD' });
    expect(res.values).toEqual([{ tokenId: 1, date: '2026-06-01', fiatValue: '20000' }]);
    expect(res.priceRefs).toHaveLength(1);
    expect(res.priceRefs[0]).toMatchObject({ currency: 'USD', source: 'defillama', price: '2000' });
    expect(res.fxRefs).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
  });

  it('converts to EUR via the ECB rate and cites the fx ref', async () => {
    await seedToken(1, { symbol: 'ETH' });
    await seedSnapshot({ tokenId: 1, date: '2026-06-01', price: '2000', source: 'defillama' });
    const fxId = await seedFx({ date: '2026-06-01', rate: '1.08' });

    const res = await valueQuantities(db, [need({ tokenId: 1, amount: ds('10') })], { currency: 'EUR' });
    expect(res.values[0]?.fiatValue?.startsWith('18518.5185185185')).toBe(true);
    expect(res.fxRefs).toEqual([expect.objectContaining({ fxRateId: fxId, rate: '1.08', base: 'EUR', quote: 'USD' })]);
    expect(res.warnings).toHaveLength(0);
  });

  it('emits FX_DATE_SHIFTED when only a prior ECB rate exists', async () => {
    await seedToken(1);
    await seedSnapshot({ tokenId: 1, date: '2026-05-31', price: '2000', source: 'defillama' });
    await seedFx({ date: '2026-05-29', rate: '1.08' }); // 2026-05-31 is Sunday

    const res = await valueQuantities(db, [need({ tokenId: 1, amount: ds('1'), date: '2026-05-31' })], { currency: 'EUR' });
    expect(res.values[0]?.fiatValue).toBeDefined();
    expect(res.warnings.map((w) => w.code)).toContain('FX_DATE_SHIFTED');
  });

  it('omits the value and warns PRICE_MISSING when no snapshot exists', async () => {
    await seedToken(1);
    const res = await valueQuantities(db, [need({ tokenId: 1, amount: ds('5') })], { currency: 'USD' });
    expect(res.values).toEqual([{ tokenId: 1, date: '2026-06-01' }]);
    expect(res.priceRefs).toHaveLength(0);
    expect(res.warnings.map((w) => w.code)).toEqual(['PRICE_MISSING']);
  });

  it('values a stablecoin at peg (1.0) under peg_for_stables, ignoring the market row', async () => {
    await seedToken(2, { decimals: 6, isStablecoin: true, pegCurrency: 'USD', symbol: 'USDC' });
    await seedSnapshot({ tokenId: 2, date: '2026-06-01', price: '0.997', source: 'defillama' });
    const pegId = await seedSnapshot({ tokenId: 2, date: '2026-06-01', price: '1', source: 'peg' });

    const peg = await valueQuantities(
      db, [need({ tokenId: 2, amount: ds('500'), isStablecoin: true, pegCurrency: 'USD', symbol: 'USDC' })],
      { currency: 'USD', policy: 'peg_for_stables' },
    );
    expect(peg.values[0]?.fiatValue).toBe('500');
    expect(peg.priceRefs[0]).toMatchObject({ snapshotId: pegId, source: 'peg', price: '1' });

    const market = await valueQuantities(
      db, [need({ tokenId: 2, amount: ds('500'), isStablecoin: true, pegCurrency: 'USD' })],
      { currency: 'USD', policy: 'market' },
    );
    expect(market.values[0]?.fiatValue).toBe('498.5'); // 500 × 0.997
    expect(market.priceRefs[0]?.source).toBe('defillama');
  });

  it('dedups refs and warnings across repeated (token, date) needs', async () => {
    await seedToken(1);
    await seedSnapshot({ tokenId: 1, date: '2026-06-01', price: '2000', source: 'defillama' });
    const needs = [
      need({ tokenId: 1, amount: ds('1') }),
      need({ tokenId: 1, amount: ds('2') }),
      need({ tokenId: 9, amount: ds('1') }), // missing
      need({ tokenId: 9, amount: ds('3') }), // missing (same key)
    ];
    const res = await valueQuantities(db, needs, { currency: 'USD' });
    expect(res.priceRefs).toHaveLength(1);
    expect(res.warnings.filter((w) => w.code === 'PRICE_MISSING')).toHaveLength(1);
    expect(res.values.map((v) => v.fiatValue)).toEqual(['2000', '4000', undefined, undefined]);
  });
});
