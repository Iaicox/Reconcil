/**
 * Valuation: turn a scaled quantity into fiat with pinned provenance. Money math
 * runs through decimal.js at full precision (decimal.ts); every value carries a
 * `PriceRef` (+ `FxRef` on cross-currency) so it is reproducible and citable
 * (C4). Missing price ⇒ no value + PRICE_MISSING, never interpolation (ADR-007).
 */
import type { DecimalString } from '@pet-crypto/core';
import type { Db } from '@pet-crypto/db';

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
 * Value one need against an already-resolved snapshot (and FX if the snapshot's
 * currency differs from the target). Only USD↔EUR is supported; ECB publishes
 * base=EUR (rate = USD per 1 EUR), so USD→EUR divides and EUR→USD multiplies.
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
 * price (or no FX for a required conversion) is returned without a value and
 * raises PRICE_MISSING — never interpolated. mcp-tools composes this over ledger rows.
 */
export async function valueQuantities(
  db: Db,
  needs: ValueNeed[],
  valuation: Valuation,
): Promise<ValuationResult> {
  const target = valuation.currency;
  const policy = valuation.policy ?? 'market';
  if (needs.length === 0) return { currency: target, values: [], priceRefs: [], fxRefs: [], warnings: [] };

  const prices = await resolvePrices(db, needs, { currency: target, policy });

  // FX is needed only when a winning snapshot is not already in the target currency.
  const fxDates = new Set<string>();
  for (const need of needs) {
    const snap = prices.get(priceKey(need.tokenId, need.date));
    if (snap && snap.currency !== target) fxDates.add(need.date);
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
