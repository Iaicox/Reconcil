/**
 * `analytics_balances` (contract §6.1) — token balances per wallet, optionally
 * valued. Composes ledger quantities (`computeBalances`) with pricing
 * (`valueQuantities`) behind the citation envelope: every figure is reproducible
 * from `event_refs`/`event_ref_summary` (C1/C3) and pinned `price_refs`/`fx_refs`
 * (C4); coverage gaps surface as warnings (C5); only sanitized `*_display` symbols
 * reach the response (C6). The tool_call is persisted before returning (C2).
 */
import {
  analyticsBalancesInput, analyticsBalancesOutput,
  type AnalyticsBalancesInput, type AnalyticsBalancesOutput,
  type FxRef, type PriceRef, type Warning,
} from '@pet-crypto/core';
import { computeBalances, getLedgerStatus } from '@pet-crypto/ledger';
import { sumDecimals, valueQuantities, type ValueNeed } from '@pet-crypto/pricing';

import type { ToolContext } from '../context.js';
import { mapCoverage } from '../coverage.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { collectPricingRefs, toWireValuation } from '../pricing-refs.js';
import { selectRefs } from '../refs.js';
import { resolveScope } from '../scope.js';
import { toTokenView } from '../token-view.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'analytics_balances';

export async function analyticsBalances(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<AnalyticsBalancesOutput>> {
  const parsed = analyticsBalancesInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const { addresses } = await resolveScope(ctx, input.scope);
  const includeUnverified = input.include_unverified ?? false;

  // computeBalances and getLedgerStatus (coverage, C5) are independent — one round-trip wave.
  const [balances, coverage] = await Promise.all([
    computeBalances(ctx.db, {
      scope: { addresses, ...(input.chain_ids ? { chainIds: input.chain_ids } : {}) },
      ...(input.as_of ? { asOf: input.as_of } : {}),
      includeUnverified,
    }),
    getLedgerStatus(ctx.db, { addresses, ...(input.chain_ids ? { chainIds: input.chain_ids } : {}) }),
  ]);

  const dateByChain = new Map<number, string>();
  for (const a of balances.asOf) dateByChain.set(a.chainId, a.date);
  const fallbackDate = input.as_of ?? new Date().toISOString().slice(0, 10);
  const dateForRow = (chainId: number): string => input.as_of ?? dateByChain.get(chainId) ?? fallbackDate;

  // --- valuation (optional) -------------------------------------------------
  const warnings: Warning[] = [];
  const priceRefs: PriceRef[] = [];
  const fxRefs: FxRef[] = [];
  let fiatByIndex: (string | undefined)[] = [];
  if (input.valuation) {
    const needs: ValueNeed[] = balances.rows.map((r) => ({
      tokenId: r.token.tokenId,
      date: dateForRow(r.chainId),
      amount: r.amount,
      isStablecoin: r.token.isStablecoin,
      pegCurrency: r.token.pegCurrency,
      symbol: r.token.symbolDisplay,
    }));
    const valued = await valueQuantities(ctx.db, needs, toWireValuation(input.valuation));
    fiatByIndex = valued.values.map((r) => r.fiatValue);
    const c = collectPricingRefs(valued);
    priceRefs.push(...c.priceRefs); fxRefs.push(...c.fxRefs); warnings.push(...c.warnings);
  }

  // --- data -----------------------------------------------------------------
  const outBalances = balances.rows.map((r, i) => {
    const fiat = input.valuation ? fiatByIndex[i] : undefined;
    return {
      address: r.address,
      chain_id: r.chainId,
      token: toTokenView(r.token),
      amount: r.amount as string,
      ...(fiat !== undefined ? { fiat_value: fiat } : {}),
    };
  });

  let totals: { currency: string; value: string }[] | undefined;
  if (input.valuation) {
    const fiats = outBalances.map((b) => b.fiat_value).filter((x): x is string => x !== undefined);
    // Omit totals when nothing priced — a '0' total would misread as "zero value"
    // rather than "unpriced" (the PRICE_MISSING warning already carries that).
    if (fiats.length > 0) totals = [{ currency: input.valuation.currency, value: sumDecimals(fiats) }];
  }

  const asOfEffective = {
    date: input.as_of ?? (balances.asOf.length > 0 ? [...balances.asOf].map((a) => a.date).sort().at(-1)! : fallbackDate),
    per_chain: balances.asOf.filter((a) => a.block !== null).map((a) => ({ chain_id: a.chainId, block: a.block as number })),
  };

  const data: AnalyticsBalancesOutput = { as_of_effective: asOfEffective, balances: outBalances, ...(totals ? { totals } : {}) };

  // --- coverage + warnings (C5) --------------------------------------------
  const { coverageRefs, coverageWarnings } = mapCoverage(coverage);
  warnings.push(...coverageWarnings);
  if (!includeUnverified) {
    warnings.push({ code: 'UNVERIFIED_EXCLUDED', message: 'unverified (spam-suspected) tokens were excluded; pass include_unverified to include them' });
  }

  // --- citations: event refs / drilldown (C3) ------------------------------
  const refsParts = selectRefs(
    balances.rows.map((r) => r.backing),
    { tool: 'analytics_list_events', args: drilldownArgs(input) },
  );

  // --- validate the contract shape, THEN persist (C2), then respond --------
  // Validate first so a bug-produced bad result can't leave an orphan tool_calls
  // row it never returns; C2 still holds — persist precedes the response.
  try {
    analyticsBalancesOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `analytics_balances produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: coverageRefs, result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: coverageRefs, ...refsParts, priceRefs, fxRefs, warnings });
}

function drilldownArgs(input: AnalyticsBalancesInput): Record<string, unknown> {
  return { ...(input.scope !== undefined ? { scope: input.scope } : {}), ...(input.chain_ids ? { chain_ids: input.chain_ids } : {}) };
}
