/**
 * Price-fill orchestration (the worker's "prices" job calls this). Enumerate the
 * gaps the ledger could value, fetch each via the source failover, and append
 * new snapshots + ECB FX — all idempotent, so a re-run is a no-op. Provider I/O
 * and retries are the worker's concern; this is the pure orchestration seam.
 */
import type { Logger } from '@pet-crypto/core';
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
    const hit = await firstPrice(bundle.price, {
      chainSlug, address: g.address, coingeckoId: g.coingeckoId, date: g.date,
    });
    if (hit !== null) {
      snapshots.push({
        tokenId: g.tokenId, priceDate: g.date, currency: hit.price.currency,
        price: hit.price.price, source: hit.source,
      });
    }
  }
  const pricesInserted = await upsertSnapshots(db, snapshots);

  let fxInserted = 0;
  const range = await fxDateRange(db);
  if (range !== null) {
    const points = await bundle.fx.rangeRates(range.from, range.to);
    fxInserted = await upsertFxRates(
      db,
      points.map((p) => ({ rateDate: p.date, baseCurrency: 'EUR', quoteCurrency: p.quote, rate: p.rate, source: bundle.fx.source })),
    );
  }

  const result: FillResult = { gaps: gaps.length, pricesInserted, fxInserted, pegInserted };
  logger?.info('price fill complete', { ...result });
  return result;
}
