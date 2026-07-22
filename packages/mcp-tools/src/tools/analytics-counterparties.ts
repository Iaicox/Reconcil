/**
 * `analytics_counterparties` (contract §6.1) — turnover per counterparty over
 * external transfers in a period. Composes ledger's `computeCounterparties` (raw
 * per-token buckets, ADR-004) with pricing and the address book behind the
 * citation envelope: raw figures reproduce from `event_refs`/`event_ref_summary`
 * (C1/C3), per-token fiat is pinned by `price_refs`/`fx_refs` (C4), the optional
 * counterparty-level `fiat` is the summable roll-up over those pinned per-token
 * values (no new refs). Labels come from exact `entity_addresses` matches (tenant
 * shadows curated); the tool never invents names (P1). Coverage gaps surface as
 * warnings (C5); the tool_call is persisted before returning (C2); only sanitized
 * `*_display` labels reach the response (C6).
 */
import {
  analyticsCounterpartiesInput, analyticsCounterpartiesOutput,
  type AnalyticsCounterpartiesInput, type AnalyticsCounterpartiesOutput,
  type CounterpartyPerTokenView, type CounterpartyRef, type CounterpartyRowView,
  type FxRef, type PriceRef, type Warning,
} from '@pet-crypto/core';
import { computeCounterparties, getLedgerStatus } from '@pet-crypto/ledger';
import { sumDecimals, valueQuantities, type ValueNeed } from '@pet-crypto/pricing';

import type { ToolContext } from '../context.js';
import { mapCoverage } from '../coverage.js';
import { refKey, resolveEntities } from '../directory/resolve.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { collectPricingRefs, toWireValuation } from '../pricing-refs.js';
import { selectRefs } from '../refs.js';
import { resolveScope } from '../scope.js';
import { persistToolCall } from '../tool-calls.js';
import { toTokenView } from '../token-view.js';

export const TOOL_NAME = 'analytics_counterparties';
const TRANSFER_KINDS = ['native_transfer', 'erc20_transfer'] as const;

export async function analyticsCounterparties(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<AnalyticsCounterpartiesOutput>> {
  const parsed = analyticsCounterpartiesInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const { addresses } = await resolveScope(ctx, input.scope);
  const includeUnverified = input.include_unverified ?? false;
  const chainScope = input.chain_ids ? { chainIds: input.chain_ids } : {};

  const [cp, coverage] = await Promise.all([
    computeCounterparties(ctx.db, {
      scope: { addresses },
      period: input.period,
      ...chainScope,
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.top_n !== undefined ? { topN: input.top_n } : {}),
      includeUnverified,
    }),
    getLedgerStatus(ctx.db, { addresses, ...chainScope }),
  ]);

  // --- valuation (optional): value inflow + outflow of every per-token bucket (C4).
  // Representative date is period.to (no day/month sub-buckets for counterparties).
  const warnings: Warning[] = [];
  const priceRefs: PriceRef[] = [];
  const fxRefs: FxRef[] = [];
  let valued: Awaited<ReturnType<typeof valueQuantities>> | undefined;
  if (input.valuation) {
    const needs: ValueNeed[] = [];
    const date = input.period.to;
    for (const row of cp.rows) {
      for (const pt of row.perToken) {
        const common = { tokenId: pt.token.tokenId, date, isStablecoin: pt.token.isStablecoin, pegCurrency: pt.token.pegCurrency, symbol: pt.token.symbolDisplay };
        needs.push({ ...common, amount: pt.inflow }, { ...common, amount: pt.outflow });
      }
    }
    valued = await valueQuantities(ctx.db, needs, toWireValuation(input.valuation));
    const c = collectPricingRefs(valued);
    priceRefs.push(...c.priceRefs); fxRefs.push(...c.fxRefs); warnings.push(...c.warnings);
  }

  // --- resolve counterparty labels (chain-agnostic: a row is not chain-qualified) --
  const resolved = await resolveEntities(ctx, cp.rows.map((r) => ({ address: r.address })));

  // --- data (single pass; `vi` walks valued.values in the same order needs were built)
  let vi = 0;
  const rows: CounterpartyRowView[] = cp.rows.map((row) => {
    const per_token: CounterpartyPerTokenView[] = row.perToken.map((pt) => {
      let fiat: { inflow: string; outflow: string } | undefined;
      if (valued) {
        const inV = valued.values[vi]?.fiatValue;
        const outV = valued.values[vi + 1]?.fiatValue;
        vi += 2;
        // A bucket's inflow/outflow share (token, date) → same snapshot: both priced or neither.
        if (inV !== undefined && outV !== undefined) fiat = { inflow: inV, outflow: outV };
      }
      return {
        token: toTokenView(pt.token),
        inflow: pt.inflow as string,
        outflow: pt.outflow as string,
        ...(fiat ? { fiat } : {}),
      };
    });

    // Counterparty-level fiat: the summable roll-up, only when every token priced.
    let rowFiat: { inflow: string; outflow: string } | undefined;
    if (valued && per_token.length > 0 && per_token.every((p) => p.fiat !== undefined)) {
      rowFiat = {
        inflow: sumDecimals(per_token.map((p) => p.fiat!.inflow)),
        outflow: sumDecimals(per_token.map((p) => p.fiat!.outflow)),
      };
    }

    const ent = resolved.get(refKey(row.address));
    const counterparty: CounterpartyRef = ent
      ? { kind: 'entity', entity_id: ent.entityId, name: ent.name, entity_kind: ent.kind, curated: ent.curated }
      : { kind: 'address', address: row.address };

    return {
      counterparty,
      tx_count: row.txCount,
      tokens: per_token.map((p) => p.token.symbol),
      per_token,
      ...(rowFiat ? { fiat: rowFiat } : {}),
    };
  });

  const unlabeledTx = rows
    .filter((r) => r.counterparty.kind === 'address')
    .reduce((s, r) => s + r.tx_count, 0);
  const data: AnalyticsCounterpartiesOutput = {
    rows,
    unlabeled_share: { tx_count: unlabeledTx, hint: 'directory_upsert_entity' },
  };

  // --- coverage + warnings (C5) --------------------------------------------
  const { coverageRefs, coverageWarnings } = mapCoverage(coverage);
  warnings.push(...coverageWarnings);
  if (!includeUnverified) {
    warnings.push({ code: 'UNVERIFIED_EXCLUDED', message: 'unverified (spam-suspected) tokens were excluded; pass include_unverified to include them' });
  }

  // --- citations: event refs / drilldown (C3) ------------------------------
  const refsParts = selectRefs(
    cp.rows.map((r) => r.backing),
    { tool: 'analytics_list_events', args: drilldownArgs(input) },
  );

  // --- validate the contract shape, THEN persist (C2), then respond --------
  try {
    analyticsCounterpartiesOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `analytics_counterparties produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: coverageRefs, result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: coverageRefs, ...refsParts, priceRefs, fxRefs, warnings });
}

/** Backing drilldown → analytics_list_events with the filters it supports. */
function drilldownArgs(input: AnalyticsCounterpartiesInput): Record<string, unknown> {
  return {
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.chain_ids ? { chain_ids: input.chain_ids } : {}),
    period: input.period,
    kinds: [...TRANSFER_KINDS],
  };
}
