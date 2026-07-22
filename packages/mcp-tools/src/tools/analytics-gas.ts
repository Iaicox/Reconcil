/**
 * `analytics_gas` (contract §6.1) — native fee spend over a period, grouped by
 * chain (always) and optionally subdivided by wallet (payer) / month, optionally
 * valued. Composes ledger's `computeGas` with pricing (`valueQuantities`) behind
 * the citation envelope: figures reproduce from `event_refs`/`event_ref_summary`
 * (C1/C3) and pinned `price_refs`/`fx_refs` (C4); coverage gaps surface as
 * warnings (C5); the tool_call is persisted before returning (C2).
 *
 * Gas is the native token only, always shown — there is no spam filter and hence
 * no UNVERIFIED_EXCLUDED warning.
 */
import {
  analyticsGasInput, analyticsGasOutput,
  type AnalyticsGasInput, type AnalyticsGasOutput, type GasRowView,
  type FxRef, type PriceRef, type Warning,
} from '@pet-crypto/core';
import { computeGas, getLedgerStatus, type GasRow } from '@pet-crypto/ledger';
import { valueQuantities, type ValueNeed } from '@pet-crypto/pricing';

import type { ToolContext } from '../context.js';
import { mapCoverage } from '../coverage.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { collectPricingRefs, toWireValuation } from '../pricing-refs.js';
import { repDate } from '../rep-date.js';
import { selectRefs } from '../refs.js';
import { resolveScope } from '../scope.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'analytics_gas';

export async function analyticsGas(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<AnalyticsGasOutput>> {
  const parsed = analyticsGasInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const { addresses } = await resolveScope(ctx, input.scope);
  const chainScope = input.chain_ids ? { chainIds: input.chain_ids } : {};

  const [gasRows, coverage] = await Promise.all([
    computeGas(ctx.db, {
      scope: { addresses },
      period: input.period,
      ...chainScope,
      ...(input.group_by ? { groupBy: input.group_by } : {}),
    }),
    getLedgerStatus(ctx.db, { addresses, ...chainScope }),
  ]);

  // --- valuation (optional): value each row's native fee spend (C4) ---------
  const warnings: Warning[] = [];
  const priceRefs: PriceRef[] = [];
  const fxRefs: FxRef[] = [];
  let fiatByRow: (string | undefined)[] = [];
  if (input.valuation) {
    const needs: ValueNeed[] = gasRows.map((r) => ({
      tokenId: r.tokenId,
      date: repDate(r.group, input.period.to),
      amount: r.nativeAmount,
      isStablecoin: r.token.isStablecoin,
      pegCurrency: r.token.pegCurrency,
      symbol: r.token.symbolDisplay,
    }));
    const valued = await valueQuantities(ctx.db, needs, toWireValuation(input.valuation));
    fiatByRow = gasRows.map((_, i) => valued.values[i]?.fiatValue);
    const c = collectPricingRefs(valued);
    priceRefs.push(...c.priceRefs); fxRefs.push(...c.fxRefs); warnings.push(...c.warnings);
  }

  // --- data -----------------------------------------------------------------
  const rows: GasRowView[] = gasRows.map((r: GasRow, i) => ({
    group: r.group,
    native_amount: r.nativeAmount as string,
    tx_count: r.txCount,
    ...(fiatByRow[i] !== undefined ? { fiat_value: fiatByRow[i]! } : {}),
  }));
  const data: AnalyticsGasOutput = { rows };

  // --- coverage + warnings (C5) --------------------------------------------
  const { coverageRefs, coverageWarnings } = mapCoverage(coverage);
  warnings.push(...coverageWarnings);

  // --- citations: event refs / drilldown (C3) ------------------------------
  const refsParts = selectRefs(
    gasRows.map((r) => r.backing),
    { tool: 'analytics_list_events', args: drilldownArgs(input) },
  );

  // --- validate the contract shape, THEN persist (C2), then respond --------
  try {
    analyticsGasOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `analytics_gas produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: coverageRefs, result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: coverageRefs, ...refsParts, priceRefs, fxRefs, warnings });
}

/**
 * Backing drilldown → analytics_list_events restricted to gas_fee events.
 * `include_unverified: true` because computeGas applies no verified filter (the
 * native fee token is always shown); without it the drilldown's default spam
 * filter could under-enumerate a (hypothetical) unverified native.
 */
function drilldownArgs(input: AnalyticsGasInput): Record<string, unknown> {
  return {
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.chain_ids ? { chain_ids: input.chain_ids } : {}),
    period: input.period,
    kinds: ['gas_fee'],
    include_unverified: true,
  };
}
