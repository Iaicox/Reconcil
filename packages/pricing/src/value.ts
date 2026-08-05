/**
 * Valuation: turn a scaled quantity into fiat with pinned provenance. Money math
 * runs through decimal.js at full precision (decimal.ts); every value carries a
 * `PriceRef` (+ `FxRef` on cross-currency) so it is reproducible and citable
 * (C4). Missing price ⇒ no value + PRICE_MISSING, never interpolation (ADR-007).
 */
import type { DecimalString } from '@reconcil/core';
import type { Db, Tx } from '@reconcil/db';

import { divide, multiply } from './decimal.js';
import { resolveFxRates } from './fx.js';
import { priceKey, resolvePrices } from './resolve.js';
import type {
  Currency, FxRef, FxResolved, PriceRef, PricingWarning, ValuationResult, Valuation,
  ValuedNeed, SnapshotRow, ValueNeed,
} from './types.js';

export interface ValuedOne {
  value: DecimalString;
  priceRef: PriceRef;
  fxRef?: FxRef;
  warning?: PricingWarning;
}

/**
 * The single supported conversion pair (H5): ECB only publishes EUR-based rates,
 * so cross-currency valuation is EUR↔USD only. Anything else (e.g. a
 * GBP-pegged stablecoin) must degrade to PRICE_MISSING, never be silently
 * multiplied by the EUR/USD rate.
 */
function isSupportedFxPair(from: string, to: string): boolean {
  return (from === 'USD' && to === 'EUR') || (from === 'EUR' && to === 'USD');
}

/**
 * Value one need against an already-resolved snapshot (and FX if the snapshot's
 * currency differs from the target). Only USD↔EUR is supported; ECB publishes
 * base=EUR (rate = USD per 1 EUR), so USD→EUR divides and EUR→USD multiplies.
 * `valueQuantities` never calls this for an unsupported pair (it routes those to
 * PRICE_MISSING first) — the throw below documents the invariant for other
 * callers and should be unreachable in practice.
 */
export function valueOne(
  need: ValueNeed,
  snapshot: SnapshotRow,
  target: Currency,
  fx?: FxResolved,
): ValuedOne {
  let value = multiply(need.amount, snapshot.price);
  let fxRef: FxRef | undefined;
  let warning: PricingWarning | undefined;

  if (snapshot.currency !== target) {
    if (!isSupportedFxPair(snapshot.currency, target)) {
      throw new Error(`valueOne: unsupported FX pair ${snapshot.currency}→${target} (only EUR↔USD is supported)`);
    }
    if (!fx) {
      throw new Error(`valueOne: FX required to convert ${snapshot.currency}→${target} but none provided`);
    }
    const rate = fx.row.rate;
    value = snapshot.currency === 'USD' && target === 'EUR' ? divide(value, rate) : multiply(value, rate);
    fxRef = {
      fxRateId: fx.row.id, date: fx.row.rateDate, base: fx.row.baseCurrency,
      quote: fx.row.quoteCurrency, rate: rate as DecimalString, source: fx.row.source,
    };
    if (fx.shifted) {
      warning = {
        code: 'FX_DATE_SHIFTED',
        message: `ECB rate ${fx.row.rateDate} used for ${need.date}`,
        context: { rateDate: fx.row.rateDate, target: need.date },
      };
    }
  }

  const priceRef: PriceRef = {
    snapshotId: snapshot.id, token: need.symbol ?? String(need.tokenId), date: snapshot.priceDate,
    currency: snapshot.currency, source: snapshot.source, price: snapshot.price as DecimalString,
  };
  return { value, priceRef, ...(fxRef ? { fxRef } : {}), ...(warning ? { warning } : {}) };
}

/**
 * Value a batch of needs: resolve pinned snapshots (+ FX where the snapshot
 * currency differs), compute fiat, and collect dedup'd price/FX citation refs +
 * warnings. Every fiat value is covered by a ref (C4); a need with no usable
 * price, no FX for a required conversion, or a snapshot currency that isn't
 * EUR↔USD-convertible to the target (H5, e.g. a GBP-pegged stablecoin) is
 * returned without a value and raises PRICE_MISSING — never interpolated, never
 * a wrong number. mcp-tools composes this over ledger rows.
 */
export async function valueQuantities(
  db: Db | Tx,
  needs: ValueNeed[],
  valuation: Valuation,
): Promise<ValuationResult> {
  const target = valuation.currency;
  const policy = valuation.policy ?? 'market';
  if (needs.length === 0) return { currency: target, values: [], priceRefs: [], fxRefs: [], warnings: [] };

  const prices = await resolvePrices(db, needs, { currency: target, policy });

  // FX is needed only when a winning snapshot is not already in the target currency,
  // and only for the supported EUR↔USD pair — an unsupported pair is handled below by
  // routing straight to PRICE_MISSING, so there's no point resolving FX for its date.
  const fxDates = new Set<string>();
  for (const need of needs) {
    const snap = prices.get(priceKey(need.tokenId, need.date));
    if (snap && snap.currency !== target && isSupportedFxPair(snap.currency, target)) fxDates.add(need.date);
  }
  const fx = fxDates.size > 0
    ? await resolveFxRates(db, [...fxDates], { base: 'EUR', quote: 'USD' })
    : new Map<string, FxResolved>();

  const values: ValuedNeed[] = [];
  const priceRefs = new Map<number, PriceRef>();
  const fxRefs = new Map<number, FxRef>();
  const warnings: PricingWarning[] = [];
  const warned = new Set<string>();

  const missing = (need: ValueNeed, reason: string): void => {
    values.push({ tokenId: need.tokenId, date: need.date });
    const wk = `PRICE_MISSING|${priceKey(need.tokenId, need.date)}`;
    if (warned.has(wk)) return;
    warned.add(wk);
    warnings.push({
      code: 'PRICE_MISSING',
      message: `no ${reason} for token ${String(need.tokenId)} on ${need.date}`,
      context: { tokenId: need.tokenId, date: need.date, currency: target },
    });
  };

  for (const need of needs) {
    const snap = prices.get(priceKey(need.tokenId, need.date));
    if (!snap) { missing(need, 'price snapshot'); continue; }

    let fxResolved: FxResolved | undefined;
    if (snap.currency !== target) {
      if (!isSupportedFxPair(snap.currency, target)) {
        missing(need, `FX pair ${snap.currency}→${target} unsupported`);
        continue;
      }
      fxResolved = fx.get(need.date);
      if (!fxResolved) { missing(need, 'FX rate'); continue; }
    }

    const r = valueOne(need, snap, target, fxResolved);
    values.push({ tokenId: need.tokenId, date: need.date, fiatValue: r.value });
    priceRefs.set(r.priceRef.snapshotId, r.priceRef);
    if (r.fxRef) fxRefs.set(r.fxRef.fxRateId, r.fxRef);
    if (r.warning) {
      const wk = `${r.warning.code}|${need.date}`;
      if (!warned.has(wk)) { warned.add(wk); warnings.push(r.warning); }
    }
  }

  return {
    currency: target, values,
    priceRefs: [...priceRefs.values()], fxRefs: [...fxRefs.values()], warnings,
  };
}
