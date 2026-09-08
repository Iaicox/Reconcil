/**
 * Snapshot write path (ADR-007). Append-only: rows are never updated; a
 * correction is a new row under a different source. Idempotent via the existing
 * unique keys — re-running a fill inserts nothing new (ON CONFLICT DO NOTHING).
 * Peg rows are materialized so peg-policy valuations cite a real snapshot.
 */
import { fxRates, priceSnapshots, type Db } from '@reconcil/db';
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

// Postgres caps a statement at 65535 bind params; at 5 params/row a first backfill
// (multi-token, multi-year history) can overflow one INSERT. Chunk so it can't.
// 1000 rows = 5000 params, well under the cap.
const INSERT_CHUNK = 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Insert new price snapshots; returns the count actually inserted (conflicts skipped). */
export async function upsertSnapshots(db: Db, rows: SnapshotInsert[]): Promise<number> {
  let inserted = 0;
  for (const batch of chunk(rows, INSERT_CHUNK)) {
    const r = await db
      .insert(priceSnapshots)
      .values(batch)
      .onConflictDoNothing({
        target: [priceSnapshots.tokenId, priceSnapshots.priceDate, priceSnapshots.currency, priceSnapshots.source],
      })
      .returning({ id: priceSnapshots.id });
    inserted += r.length;
  }
  return inserted;
}

/** Insert new ECB FX rows; returns the count actually inserted. */
export async function upsertFxRates(db: Db, rows: FxInsert[]): Promise<number> {
  let inserted = 0;
  for (const batch of chunk(rows, INSERT_CHUNK)) {
    const r = await db
      .insert(fxRates)
      .values(batch)
      .onConflictDoNothing({
        target: [fxRates.rateDate, fxRates.baseCurrency, fxRates.quoteCurrency, fxRates.source],
      })
      .returning({ id: fxRates.id });
    inserted += r.length;
  }
  return inserted;
}

/**
 * Materialize a `source='peg'` snapshot (price 1.0 in the peg currency) for every
 * verified stablecoin on each date it appears in `chain_events`, so peg-policy
 * valuations cite a real, pinnable row even for 1.0 (ADR-007). Idempotent.
 *
 * Incrementality: the WHERE carries a `NOT EXISTS` anti-join against `price_snapshots`
 * so only (token, date) pairs that don't already have a peg row are candidates for the
 * `DISTINCT` + insert below — a steady-state daily run only does work proportional to
 * events since the last run, not the full history.
 *
 * This is deliberately NOT a time-window predicate (e.g. "block_time >= last
 * materialized date - N days"). `chain_events` is append-only, but insertion order is
 * NOT block_time order: onboarding a new wallet, or widening an existing wallet's
 * ingested window, backfills events whose `block_time` can be arbitrarily far in the
 * past relative to rows already materialized. A predicate keyed on `block_time` (or any
 * watermark derived from it) would permanently skip such a backfilled old event once the
 * watermark had advanced past its date — silently wrong, and wrong forever (nothing
 * re-triggers it). A `NOT EXISTS` per-row check has no such blind spot: it re-evaluates
 * "does this (token, date) already have a peg row" on every run regardless of when the
 * row was inserted, so a newly-backfilled old event is still covered.
 *
 * A `max chain_events.id already scanned` watermark table was the follow-up this docstring
 * used to propose, on the grounds that `id` — unlike block_time — is safely monotonic with
 * insertion order (`generatedAlwaysAsIdentity()`), so a backfilled old event gets a NEW id
 * and would still be picked up. That much is true, and it is still not enough:
 *
 * `tokens.is_stablecoin` / `tokens.verified` are CURATION flags, not immutable facts. An
 * erc20 ingested before it is curated is scanned by this query, matches nothing, and — with
 * a watermark — advances it past those events. When curation later marks that token a
 * verified stablecoin, its entire history sits below the watermark and is never revisited:
 * missing peg rows, permanently, with nothing to re-trigger them. That is exactly the
 * silent-and-wrong-forever failure the block_time paragraph above rejects, arriving through
 * a different door. `NOT EXISTS` re-evaluates every run and so self-heals the moment the
 * flag flips.
 *
 * What the flagged cost actually was — fetching every stablecoin event's heap row to read
 * `block_time` for the DISTINCT — is instead removed by indexing
 * `chain_events (token_id, block_time)`, so the DISTINCT is served from the index. No new
 * state, no new failure mode, and the anti-join keeps its self-healing property.
 */
export async function materializePegSnapshots(db: Db): Promise<number> {
  const res = await db.execute(sql`
    INSERT INTO price_snapshots (token_id, price_date, currency, price, source)
    SELECT DISTINCT ce.token_id, (ce.block_time AT TIME ZONE 'UTC')::date, t.peg_currency, 1::numeric, 'peg'
    FROM chain_events ce
    JOIN tokens t ON t.id = ce.token_id
    WHERE t.is_stablecoin = true AND t.verified = true AND t.peg_currency IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM price_snapshots ps
        WHERE ps.token_id = ce.token_id
          AND ps.price_date = (ce.block_time AT TIME ZONE 'UTC')::date
          AND ps.currency = t.peg_currency
          AND ps.source = 'peg'
      )
    ON CONFLICT (token_id, price_date, currency, source) DO NOTHING
  `);
  return (res as { rowCount?: number }).rowCount ?? 0;
}
