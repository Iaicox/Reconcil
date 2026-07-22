/**
 * `analytics_list_events` (contract §6.1) — paged, filtered event listing and the
 * universal drilldown / citation target (C3): every `event_ref_summary.drilldown`
 * in the system resolves to a call of this tool. Wraps ledger's keyset-paginated
 * `listEvents`; citations are trivially the returned events themselves (C1).
 * Coverage gaps surface as warnings (C5); the tool_call is persisted before
 * returning (C2). Only sanitized `*_display` labels reach the response (C6);
 * `AddressView.entity` is populated from the address book (directory_*, tenant
 * shadows curated) whenever an endpoint is labeled.
 */
import {
  analyticsListEventsInput, analyticsListEventsOutput,
  type AddressView, type AnalyticsListEventsOutput, type EventListItemView, type Warning,
} from '@pet-crypto/core';
import { getLedgerStatus, listEvents, type EventListItem, type ListEventsParams } from '@pet-crypto/ledger';

import type { ToolContext } from '../context.js';
import { mapCoverage } from '../coverage.js';
import { refKey, resolveEntities, type ResolvedEntity } from '../directory/resolve.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { selectRefs } from '../refs.js';
import { resolveScope } from '../scope.js';
import { persistToolCall } from '../tool-calls.js';
import { toTokenView } from '../token-view.js';

export const TOOL_NAME = 'analytics_list_events';

export async function analyticsListEvents(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<AnalyticsListEventsOutput>> {
  const parsed = analyticsListEventsInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const { addresses } = await resolveScope(ctx, input.scope);
  const chainScope = input.chain_ids ? { chainIds: input.chain_ids } : {};

  const params: ListEventsParams = {
    scope: { addresses },
    ...(input.period ? { period: input.period } : {}),
    ...chainScope,
    ...(input.tokens ? { tokens: input.tokens.map((t) => ({ chainId: t.chain_id, address: t.address })) } : {}),
    ...(input.counterparty_address !== undefined ? { counterpartyAddress: input.counterparty_address } : {}),
    ...(input.kinds ? { kinds: input.kinds } : {}),
    ...(input.min_amount !== undefined ? { minAmount: input.min_amount } : {}),
    ...(input.include_unverified !== undefined ? { includeUnverified: input.include_unverified } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };

  let listed: Awaited<ReturnType<typeof listEvents>>;
  let coverage: Awaited<ReturnType<typeof getLedgerStatus>>;
  try {
    [listed, coverage] = await Promise.all([
      listEvents(ctx.db, params),
      getLedgerStatus(ctx.db, { addresses, ...chainScope }),
    ]);
  } catch (err) {
    // ledger guards min_amount's shape as a clean RangeError; surface it as a
    // domain INVALID_INPUT rather than an opaque INTERNAL (contract §4).
    if (err instanceof RangeError) throw new ToolError('INVALID_INPUT', err.message);
    throw err;
  }

  // --- data: map ledger events → wire (C6) ----------------------------------
  // Label both endpoints from the address book (directory_*); resolution is
  // (address, chain)-qualified and tenant-scoped (tenant shadows curated).
  const resolved = await resolveEntities(
    ctx,
    listed.events.flatMap((e) => [
      { address: e.fromAddr, chainId: e.chainId },
      { address: e.toAddr, chainId: e.chainId },
    ]),
  );
  const events: EventListItemView[] = listed.events.map((e) => toWire(e, resolved));
  const data: AnalyticsListEventsOutput = {
    events,
    ...(listed.nextCursor !== undefined ? { next_cursor: listed.nextCursor } : {}),
    ...(listed.totalCount !== undefined ? { total_count: listed.totalCount } : {}),
  };

  // --- coverage + warnings (C5) --------------------------------------------
  const warnings: Warning[] = [];
  const { coverageRefs, coverageWarnings } = mapCoverage(coverage);
  warnings.push(...coverageWarnings);
  if (!(input.include_unverified ?? false)) {
    // parity with analytics_balances/flows: the default spam filter hides unverified tokens
    warnings.push({ code: 'UNVERIFIED_EXCLUDED', message: 'unverified (spam-suspected) tokens were excluded; pass include_unverified to include them' });
  }

  // --- citations: the returned page IS the backing set (C1/C3). Wrap the page
  // as one backing; selectRefs inlines it (≤ cap) or summarizes with a drilldown
  // back to this same tool enumerating the full set.
  const backing = {
    refs: listed.events.map((e) => ({ chainId: e.chainId, txHash: e.txHash, logIndex: e.logIndex })),
    totalCount: listed.totalCount ?? listed.events.length,
  };
  const refsParts = selectRefs([backing], { tool: 'analytics_list_events', args: input as Record<string, unknown> });

  // --- validate the contract shape, THEN persist (C2), then respond --------
  try {
    analyticsListEventsOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `analytics_list_events produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: coverageRefs, result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: coverageRefs, ...refsParts, warnings });
}

function toWire(e: EventListItem, resolved: Map<string, ResolvedEntity>): EventListItemView {
  return {
    chain_id: e.chainId,
    tx_hash: e.txHash,
    log_index: e.logIndex,
    kind: e.kind,
    block_number: e.blockNumber,
    block_time: e.blockTime,
    token: toTokenView(e.token),
    amount: e.amount as string,
    amount_raw: e.amountRaw,
    from: addressView(e.fromAddr, e.chainId, resolved),
    to: addressView(e.toAddr, e.chainId, resolved),
    direction: e.direction,
  };
}

/** A resolved endpoint; `entity` (no `entity_kind` here, per §6.1) when labeled. */
function addressView(address: string, chainId: number, resolved: Map<string, ResolvedEntity>): AddressView {
  const ent = resolved.get(refKey(address, chainId));
  return ent !== undefined
    ? { address, entity: { entity_id: ent.entityId, name: ent.name, curated: ent.curated } }
    : { address };
}
