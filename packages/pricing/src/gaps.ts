/**
 * The fill worklist: which (token, date) closes and which FX dates are still
 * missing, derived from `chain_events` (only what the ledger could actually
 * value). A price gap = a verified token on a UTC activity date with no market
 * snapshot yet ('peg' rows don't count — they aren't a market price).
 */
import { chainEvents, tokens, type Db } from '@pet-crypto/db';
import { and, eq, sql } from 'drizzle-orm';

export interface PriceGap {
  tokenId: number;
  chainId: number;
  address: string | null;
  coingeckoId: string | null;
  isStablecoin: boolean;
  pegCurrency: string | null;
  date: string; // 'YYYY-MM-DD'
}

const utcDate = sql<string>`(${chainEvents.blockTime} AT TIME ZONE 'UTC')::date`;

export async function priceGaps(db: Db, opts: { verifiedOnly?: boolean } = {}): Promise<PriceGap[]> {
  const verifiedOnly = opts.verifiedOnly ?? true;
  const rows = await db
    .selectDistinct({
      tokenId: tokens.id,
      chainId: tokens.chainId,
      address: tokens.address,
      coingeckoId: tokens.coingeckoId,
      isStablecoin: tokens.isStablecoin,
      pegCurrency: tokens.pegCurrency,
      date: utcDate,
    })
    .from(chainEvents)
    .innerJoin(tokens, eq(tokens.id, chainEvents.tokenId))
    .where(and(
      verifiedOnly ? eq(tokens.verified, true) : undefined,
      sql`NOT EXISTS (
        SELECT 1 FROM price_snapshots ps
        WHERE ps.token_id = ${chainEvents.tokenId}
          AND ps.price_date = ${utcDate}
          AND ps.currency = 'USD'
          AND ps.source <> 'peg'
      )`,
    ));
  return rows.map((r) => ({ ...r, date: String(r.date) }));
}

/**
 * The date window ECB rates are needed for: min…max UTC activity date, widened a
 * week earlier so a weekend/holiday target always has a prior business-day rate.
 */
export async function fxDateRange(db: Db): Promise<{ from: string; to: string } | null> {
  const [row] = await db
    .select({
      min: sql<string | null>`min((${chainEvents.blockTime} AT TIME ZONE 'UTC')::date)`,
      max: sql<string | null>`max((${chainEvents.blockTime} AT TIME ZONE 'UTC')::date)`,
    })
    .from(chainEvents);
  if (!row?.min || !row.max) return null;
  const from = new Date(`${row.min}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 7);
  return { from: from.toISOString().slice(0, 10), to: row.max };
}
