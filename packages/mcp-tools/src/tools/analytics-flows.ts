/**
 * `analytics_flows` (contract §6.1) — inbound/outbound/net movements over a
 * period, grouped by token and optionally subdivided by counterparty/day/month.
 * Composes ledger's `computeFlows` with pricing (`valueQuantities`) behind the
 * citation envelope: figures reproduce from `event_refs`/`event_ref_summary`
 * (C1/C3) and pinned `price_refs`/`fx_refs` (C4); coverage gaps surface as
 * warnings (C5); only sanitized `*_display` labels reach the response (C6). The
 * tool_call is persisted before returning (C2).
 *
 * Self-transfers between two in-scope wallets are reported in a sibling
 * `internal_transfers` array, never as external flow. Flow fiat values use a
 * representative date per row (day/month bucket → that period; else `period.to`).
 */
import {
  analyticsFlowsInput, analyticsFlowsOutput,
  type AnalyticsFlowsInput, type AnalyticsFlowsOutput, type FlowRowView,
  type FxRef, type PriceRef, type Warning,
} from '@pet-crypto/core';
import { tokens, type Db } from '@pet-crypto/db';
import { computeFlows, getLedgerStatus, type FlowRow } from '@pet-crypto/ledger';
import { valueQuantities, type ValueNeed } from '@pet-crypto/pricing';
import { and, eq, isNull } from 'drizzle-orm';

import type { ToolContext } from '../context.js';
import { mapCoverage } from '../coverage.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { selectRefs } from '../refs.js';
import { resolveScope } from '../scope.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'analytics_flows';
const TRANSFER_KINDS = ['native_transfer', 'erc20_transfer'] as const;

export async function analyticsFlows(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<AnalyticsFlowsOutput>> {
  const parsed = analyticsFlowsInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const { addresses } = await resolveScope(ctx, input.scope);
  const includeUnverified = input.include_unverified ?? false;
  const chainScope = input.chain_ids ? { chainIds: input.chain_ids } : {};

  // A `token` filter that matches nothing must yield empty flows, not "no filter":
  // computeFlows treats an empty restrict set as unrestricted, so short-circuit here.
  const restrictTokenIds = input.token ? await resolveTokenIds(ctx.db, input.token) : undefined;
  const noMatch = input.token !== undefined && restrictTokenIds!.length === 0;

  const [flows, coverage] = await Promise.all([
    noMatch
      ? Promise.resolve({ rows: [], internal: [] })
      : computeFlows(ctx.db, {
          scope: { addresses },
          period: input.period,
          ...chainScope, // computeFlows reads chainIds at the top level
          ...(input.direction ? { direction: input.direction } : {}),
          ...(input.group_by ? { groupBy: input.group_by } : {}),
          ...(restrictTokenIds ? { restrictTokenIds } : {}),
          includeUnverified,
        }),
    getLedgerStatus(ctx.db, { addresses, ...chainScope }),
  ]);

  // --- valuation (optional): value inflow and outflow of every row (C4) -----
  const warnings: Warning[] = [];
  const priceRefs: PriceRef[] = [];
  const fxRefs: FxRef[] = [];
  const allRows = [...flows.rows, ...flows.internal];
  let fiatByRow: (FlowRowView['fiat'] | undefined)[] = [];
  if (input.valuation) {
    const needs: ValueNeed[] = [];
    for (const r of allRows) {
      const date = repDate(r.group, input.period.to);
      const common = { tokenId: r.tokenId, date, isStablecoin: r.token.isStablecoin, pegCurrency: r.token.pegCurrency, symbol: r.token.symbolDisplay };
      needs.push({ ...common, amount: r.inflow }, { ...common, amount: r.outflow });
    }
    const v = input.valuation;
    const valuation = v.policy !== undefined ? { currency: v.currency, policy: v.policy } : { currency: v.currency };
    const valued = await valueQuantities(ctx.db, needs, valuation);
    // A row's inflow/outflow share (token, date) → the same snapshot: both priced or both missing.
    fiatByRow = allRows.map((_, i) => {
      const inV = valued.values[i * 2]?.fiatValue;
      const outV = valued.values[i * 2 + 1]?.fiatValue;
      return inV !== undefined && outV !== undefined ? { inflow: inV, outflow: outV } : undefined;
    });
    for (const p of valued.priceRefs) priceRefs.push({ snapshot_id: p.snapshotId, token: p.token, date: p.date, currency: p.currency, source: p.source, price: p.price });
    for (const f of valued.fxRefs) fxRefs.push({ fx_rate_id: f.fxRateId, date: f.date, base: f.base, quote: f.quote, rate: f.rate, source: f.source });
    for (const w of valued.warnings) warnings.push({ code: w.code, message: w.message, ...(w.context ? { context: w.context } : {}) });
  }

  // --- data -----------------------------------------------------------------
  const toView = (r: FlowRow, fiat: FlowRowView['fiat'] | undefined): FlowRowView => ({
    group: r.group,
    inflow: r.inflow as string,
    outflow: r.outflow as string,
    net: r.net as string,
    tx_count: r.txCount,
    ...(fiat ? { fiat } : {}),
  });
  const rows = flows.rows.map((r, i) => toView(r, fiatByRow[i]));
  const internal_transfers = flows.internal.map((r, i) => toView(r, fiatByRow[flows.rows.length + i]));
  const data: AnalyticsFlowsOutput = { rows, internal_transfers };

  // --- coverage + warnings (C5) --------------------------------------------
  const { coverageRefs, coverageWarnings } = mapCoverage(coverage);
  warnings.push(...coverageWarnings);
  if (!includeUnverified) {
    warnings.push({ code: 'UNVERIFIED_EXCLUDED', message: 'unverified (spam-suspected) tokens were excluded; pass include_unverified to include them' });
  }

  // --- citations: event refs / drilldown (C3) ------------------------------
  const refsParts = selectRefs(
    allRows.map((r) => r.backing),
    { tool: 'analytics_list_events', args: drilldownArgs(input) },
  );

  // --- validate the contract shape, THEN persist (C2), then respond --------
  try {
    analyticsFlowsOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `analytics_flows produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: coverageRefs, result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: coverageRefs, ...refsParts, priceRefs, fxRefs, warnings });
}

/** Representative valuation date for a row: day bucket → that day; month → month end; else period end. */
function repDate(group: Record<string, string>, periodTo: string): string {
  if (group.day !== undefined) return group.day;
  if (group.month !== undefined) return lastDayOfMonth(group.month);
  return periodTo;
}

function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const day = new Date(Date.UTC(y!, m!, 0)).getUTCDate(); // day 0 of next month = last day of this
  return `${ym}-${String(day).padStart(2, '0')}`;
}

async function resolveTokenIds(db: Db, t: { chain_id: number; address: string | null }): Promise<number[]> {
  const addrCond = t.address === null ? isNull(tokens.address) : eq(tokens.address, t.address.toLowerCase());
  const rows = await db.select({ id: tokens.id }).from(tokens).where(and(eq(tokens.chainId, t.chain_id), addrCond));
  return rows.map((r) => r.id);
}

/** Backing drilldown → analytics_list_events with the filters it supports. */
function drilldownArgs(input: AnalyticsFlowsInput): Record<string, unknown> {
  return {
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.chain_ids ? { chain_ids: input.chain_ids } : {}),
    period: input.period,
    ...(input.token ? { tokens: [input.token] } : {}),
    kinds: [...TRANSFER_KINDS],
  };
}
