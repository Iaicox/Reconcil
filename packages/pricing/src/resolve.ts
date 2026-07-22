/**
 * Price-snapshot resolution: pick the one winning `price_snapshots` row per
 * (token, date) the valuation will cite (ADR-007). Source priority
 * manual > defillama > coingecko > peg; peg rows are used only for stablecoins
 * under peg policy. A target-currency snapshot beats a USD one that would need
 * FX. No winner ⇒ the caller emits PRICE_MISSING (never interpolates, C4).
 */
import { priceSnapshots, type Db } from '@pet-crypto/db';
import { and, inArray } from 'drizzle-orm';

import type { Currency, SnapshotRow, ValuationPolicy, ValueNeed } from './types.js';

const SOURCE_RANK: Record<string, number> = { manual: 0, defillama: 1, coingecko: 2, peg: 3 };

/** Preference key (lower wins): currency (target > USD > other), then source rank. */
function marketPref(c: SnapshotRow, target: Currency): number {
  const cur = c.currency === target ? 0 : c.currency === 'USD' ? 1 : 2;
  return cur * 10 + (SOURCE_RANK[c.source] ?? 9);
}

export function pickSnapshot(
  candidates: SnapshotRow[],
  need: ValueNeed,
  target: Currency,
  policy: ValuationPolicy,
): SnapshotRow | undefined {
  if (policy === 'peg_for_stables' && need.isStablecoin && need.pegCurrency) {
    const peg = candidates.find((c) => c.source === 'peg');
    if (peg) return peg; // else fall through: peg row not materialized yet → market
  }
  const market = candidates.filter((c) => c.source !== 'peg');
  if (market.length === 0) return undefined;
  return market.reduce((best, c) => (marketPref(c, target) < marketPref(best, target) ? c : best));
}

/** Stable map key for a (token, date) valuation need. */
export const priceKey = (tokenId: number, date: string): string => `${String(tokenId)}|${date}`;
const key = priceKey;

/** Resolve the winning snapshot per (token, date); absent keys are PRICE_MISSING. */
export async function resolvePrices(
  db: Db,
  needs: ValueNeed[],
  opts: { currency: Currency; policy: ValuationPolicy },
): Promise<Map<string, SnapshotRow>> {
  const out = new Map<string, SnapshotRow>();
  const tokenIds = [...new Set(needs.map((n) => n.tokenId))];
  const dates = [...new Set(needs.map((n) => n.date))];
  if (tokenIds.length === 0) return out;

  const rows = await db
    .select({
      id: priceSnapshots.id, tokenId: priceSnapshots.tokenId, priceDate: priceSnapshots.priceDate,
      currency: priceSnapshots.currency, price: priceSnapshots.price, source: priceSnapshots.source,
    })
    .from(priceSnapshots)
    .where(and(
      inArray(priceSnapshots.tokenId, tokenIds),
      inArray(priceSnapshots.priceDate, dates),
      inArray(priceSnapshots.currency, [...new Set<string>([opts.currency, 'USD'])]),
    ));

  const byKey = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const k = key(r.tokenId, r.priceDate);
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }
  for (const need of needs) {
    const k = key(need.tokenId, need.date);
    if (out.has(k)) continue;
    const winner = pickSnapshot(byKey.get(k) ?? [], need, opts.currency, opts.policy);
    if (winner) out.set(k, winner);
  }
  return out;
}
