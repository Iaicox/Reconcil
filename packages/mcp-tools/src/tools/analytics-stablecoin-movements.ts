/**
 * `analytics_stablecoin_movements` (contract §6.1) — the single most common
 * accountant question, so it gets a stable contract: flows restricted to verified
 * stablecoins, plus per-peg subtotals. Sugar over ledger's
 * `computeStablecoinMovements` (which reuses the flow fold on the verified-
 * stablecoin token set) behind the citation envelope.
 *
 * Row-level fiat is intentionally absent (the contract input carries no
 * `valuation`); the value story is the **per-peg subtotals**, computed under peg
 * policy — a USD-pegged stablecoin is worth its face in USD — so each subtotal is
 * pinned by synthetic `source='peg'` price_refs (C4). Backing events reproduce the
 * figures (C1/C3); coverage gaps surface as warnings (C5); tool_call persisted
 * before returning (C2); only sanitized `*_display` labels reach the wire (C6).
 */
import {
  analyticsStablecoinInput, analyticsStablecoinOutput,
  type AnalyticsStablecoinInput, type AnalyticsStablecoinOutput,
  type FlowRowView, type PegSubtotal, type FxRef, type PriceRef, type Warning,
} from '@pet-crypto/core';
import { computeStablecoinMovements, getLedgerStatus, type FlowRow } from '@pet-crypto/ledger';
import { sumDecimals, valueQuantities, type ValueNeed } from '@pet-crypto/pricing';

import type { ToolContext } from '../context.js';
import { mapCoverage } from '../coverage.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { repDate } from '../rep-date.js';
import { selectRefs } from '../refs.js';
import { resolveScope } from '../scope.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'analytics_stablecoin_movements';
const TRANSFER_KINDS = ['native_transfer', 'erc20_transfer'] as const;

export async function analyticsStablecoinMovements(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<AnalyticsStablecoinOutput>> {
  const parsed = analyticsStablecoinInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const { addresses } = await resolveScope(ctx, input.scope);

  const [sc, coverage] = await Promise.all([
    computeStablecoinMovements(ctx.db, {
      scope: { addresses },
      period: input.period,
      ...(input.peg_currency ? { pegCurrency: input.peg_currency } : {}),
      ...(input.group_by ? { groupBy: input.group_by } : {}),
    }),
    getLedgerStatus(ctx.db, { addresses }),
  ]);

  // --- per-peg subtotals (C4): face value under peg policy, over external flows.
  // Internal (self) transfers are neither inflow nor outflow and are excluded.
  const warnings: Warning[] = [];
  const priceRefs: PriceRef[] = [];
  const fxRefs: FxRef[] = [];
  const pegSubtotals: PegSubtotal[] = [];

  const byPeg = new Map<'USD' | 'EUR', FlowRow[]>();
  for (const r of sc.rows) {
    const peg = r.token.pegCurrency;
    if (peg !== 'USD' && peg !== 'EUR') continue; // only pegs we can value
    const list = byPeg.get(peg) ?? [];
    list.push(r);
    byPeg.set(peg, list);
  }
  for (const [peg, rowsForPeg] of [...byPeg].sort(([a], [b]) => a.localeCompare(b))) {
    const needs: ValueNeed[] = [];
    for (const r of rowsForPeg) {
      const date = repDate(r.group, input.period.to);
      const common = { tokenId: r.tokenId, date, isStablecoin: r.token.isStablecoin, pegCurrency: r.token.pegCurrency, symbol: r.token.symbolDisplay };
      needs.push({ ...common, amount: r.inflow }, { ...common, amount: r.outflow }); // even = inflow, odd = outflow
    }
    const valued = await valueQuantities(ctx.db, needs, { currency: peg, policy: 'peg_for_stables' });
    const inflows: string[] = [];
    const outflows: string[] = [];
    valued.values.forEach((v, i) => {
      if (v.fiatValue === undefined) return;
      (i % 2 === 0 ? inflows : outflows).push(v.fiatValue);
    });
    pegSubtotals.push({ peg_currency: peg, inflow: sumDecimals(inflows), outflow: sumDecimals(outflows) });
    for (const p of valued.priceRefs) priceRefs.push({ snapshot_id: p.snapshotId, token: p.token, date: p.date, currency: p.currency, source: p.source, price: p.price });
    for (const f of valued.fxRefs) fxRefs.push({ fx_rate_id: f.fxRateId, date: f.date, base: f.base, quote: f.quote, rate: f.rate, source: f.source });
    for (const w of valued.warnings) warnings.push({ code: w.code, message: w.message, ...(w.context ? { context: w.context } : {}) });
  }

  // --- data (flows shape; row-level fiat omitted) ---------------------------
  const toView = (r: FlowRow): FlowRowView => ({
    group: r.group,
    inflow: r.inflow as string,
    outflow: r.outflow as string,
    net: r.net as string,
    tx_count: r.txCount,
  });
  const data: AnalyticsStablecoinOutput = {
    rows: sc.rows.map(toView),
    internal_transfers: sc.internal.map(toView),
    peg_subtotals: pegSubtotals,
  };

  // --- coverage + warnings (C5) --------------------------------------------
  const { coverageRefs, coverageWarnings } = mapCoverage(coverage);
  warnings.push(...coverageWarnings);

  // --- citations: event refs / drilldown (C3) ------------------------------
  const allRows = [...sc.rows, ...sc.internal];
  const refsParts = selectRefs(
    allRows.map((r) => r.backing),
    { tool: 'analytics_list_events', args: drilldownArgs(input, allRows) },
  );

  // --- validate the contract shape, THEN persist (C2), then respond --------
  try {
    analyticsStablecoinOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `analytics_stablecoin_movements produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: coverageRefs, result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: coverageRefs, ...refsParts, priceRefs, fxRefs, warnings });
}

/**
 * Backing drilldown → analytics_list_events restricted to exactly the stablecoin
 * tokens that appear in the result (tokens with no activity have no backing), so
 * the drilldown enumerates the same event set (C3).
 */
function drilldownArgs(input: AnalyticsStablecoinInput, rows: FlowRow[]): Record<string, unknown> {
  const seen = new Set<string>();
  const tokens: { chain_id: number; address: string | null }[] = [];
  for (const r of rows) {
    const key = `${String(r.token.chainId)}|${r.token.address ?? 'native'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ chain_id: r.token.chainId, address: r.token.address });
  }
  return {
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    period: input.period,
    ...(tokens.length > 0 ? { tokens } : {}),
    kinds: [...TRANSFER_KINDS],
  };
}
