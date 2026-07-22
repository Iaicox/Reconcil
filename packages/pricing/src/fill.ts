/**
 * Price-fill orchestration (the worker's "prices" job calls this). Enumerate the
 * gaps the ledger could value, fetch each via the source failover, and append
 * new snapshots + ECB FX — all idempotent, so a re-run is a no-op. Provider I/O
 * and retries are the worker's concern; this is the pure orchestration seam.
 */
import { serializeError, type Logger } from '@pet-crypto/core';
import type { Db } from '@pet-crypto/db';

import { fxDateRange, priceGaps } from './gaps.js';
import { firstPrice } from './providers/provider-factory.js';
import { CHAIN_SLUG, type PriceBundle } from './providers/types.js';
import { materializePegSnapshots, upsertFxRates, upsertSnapshots, type SnapshotInsert } from './snapshot-service.js';

export interface FillDeps {
  db: Db;
  bundle: PriceBundle;
  logger?: Logger;
}

export interface FillResult {
  gaps: number;
  pricesInserted: number;
  fxInserted: number;
  pegInserted: number;
}

export async function runPriceFill(deps: FillDeps): Promise<FillResult> {
  const { db, bundle, logger } = deps;

  const pegInserted = await materializePegSnapshots(db);

  const gaps = await priceGaps(db);
  const snapshots: SnapshotInsert[] = [];
  for (const g of gaps) {
    const chainSlug = CHAIN_SLUG[g.chainId];
    if (chainSlug === undefined) continue; // chain not price-mapped yet
    // One job processes every gap, so a single fetch rejection (network/timeout)
    // must not abort the batch or discard the snapshots already gathered — treat a
    // throw like a miss and carry on (the gap simply re-tries next daily tick).
    try {
      const hit = await firstPrice(bundle.price, {
        chainSlug, address: g.address, coingeckoId: g.coingeckoId, date: g.date,
      });
      if (hit !== null) {
        snapshots.push({
          tokenId: g.tokenId, priceDate: g.date, currency: hit.price.currency,
          price: hit.price.price, source: hit.source,
        });
      }
    } catch (err) {
      logger?.warn('price fetch failed; skipping gap', { tokenId: g.tokenId, date: g.date, err: serializeError(err) });
    }
  }
  const pricesInserted = await upsertSnapshots(db, snapshots);

  // FX is independent of the price appends above; a failure here must not undo them.
  let fxInserted = 0;
  try {
    const range = await fxDateRange(db);
    if (range !== null) {
      const points = await bundle.fx.rangeRates(range.from, range.to);
      fxInserted = await upsertFxRates(
        db,
        points.map((p) => ({ rateDate: p.date, baseCurrency: 'EUR', quoteCurrency: p.quote, rate: p.rate, source: bundle.fx.source })),
      );
    }
  } catch (err) {
    logger?.warn('FX fetch failed; prices already persisted', { err: serializeError(err) });
  }

  const result: FillResult = { gaps: gaps.length, pricesInserted, fxInserted, pegInserted };
  logger?.info('price fill complete', { ...result });
  return result;
}
