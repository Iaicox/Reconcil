/**
 * Snapshot write path (ADR-007). Append-only: rows are never updated; a
 * correction is a new row under a different source. Idempotent via the existing
 * unique keys — re-running a fill inserts nothing new (ON CONFLICT DO NOTHING).
 * Peg rows are materialized so peg-policy valuations cite a real snapshot.
 */
import { fxRates, priceSnapshots, type Db } from '@pet-crypto/db';
import { sql } from 'drizzle-orm';

export interface SnapshotInsert {
  tokenId: number;
  priceDate: string; // 'YYYY-MM-DD'
  currency: string;
  price: string;
  source: string; // 'defillama' | 'coingecko' | 'manual'
}

export interface FxInsert {
  rateDate: string;
  baseCurrency: string; // 'EUR'
  quoteCurrency: string; // 'USD'
  rate: string;
  source: string; // 'ecb'
}

/** Insert new price snapshots; returns the count actually inserted (conflicts skipped). */
export async function upsertSnapshots(db: Db, rows: SnapshotInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(priceSnapshots)
    .values(rows)
    .onConflictDoNothing({
      target: [priceSnapshots.tokenId, priceSnapshots.priceDate, priceSnapshots.currency, priceSnapshots.source],
    })
    .returning({ id: priceSnapshots.id });
  return inserted.length;
}

/** Insert new ECB FX rows; returns the count actually inserted. */
export async function upsertFxRates(db: Db, rows: FxInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(fxRates)
    .values(rows)
    .onConflictDoNothing({
      target: [fxRates.rateDate, fxRates.baseCurrency, fxRates.quoteCurrency, fxRates.source],
    })
    .returning({ id: fxRates.id });
  return inserted.length;
}

/**
 * Materialize a `source='peg'` snapshot (price 1.0 in the peg currency) for every
 * verified stablecoin on each date it appears in `chain_events`, so peg-policy
 * valuations cite a real, pinnable row even for 1.0 (ADR-007). Idempotent.
 */
export async function materializePegSnapshots(db: Db): Promise<number> {
  const res = await db.execute(sql`
    INSERT INTO price_snapshots (token_id, price_date, currency, price, source)
    SELECT DISTINCT ce.token_id, (ce.block_time AT TIME ZONE 'UTC')::date, t.peg_currency, 1::numeric, 'peg'
    FROM chain_events ce
    JOIN tokens t ON t.id = ce.token_id
    WHERE t.is_stablecoin = true AND t.verified = true AND t.peg_currency IS NOT NULL
    ON CONFLICT (token_id, price_date, currency, source) DO NOTHING
  `);
  return (res as { rowCount?: number }).rowCount ?? 0;
}
