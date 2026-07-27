/**
 * HITL decision persistence (recon_confirm_match / recon_reject_match, §6.4/ADR-010).
 * A single leg (`matches` row) is transitioned `suggested → confirmed|rejected` inside a
 * SERIALIZABLE transaction — the one place the cross-row matching invariants are enforced
 * (the engine only proposes; suggestions carry no guarantees). Confirm re-checks that the
 * event is not over-applied (`MATCH_CONFLICT`) and recomputes the parent record's status
 * from its confirmed legs via the pure `deriveRecordStatus`. Reject frees the event (a
 * rejected leg contributes nothing) and leaves the record status to fall out of the
 * remaining confirmed legs.
 *
 * Valuation carries through whatever suggest pinned on the leg (C4): a stablecoin face-value
 * leg has no `price_snapshot_id`/`fx_rate_id` (reproducible at peg, P5), so its refs stay
 * absent; a volatile-token leg re-hydrates its pinned `priceRef`/`fxRef` from
 * `price_snapshots`/`fx_rates` for the decision envelope. The record-status math always uses
 * the stored `fiat_value` (the canonical band, ADR-010) — never a fresh price.
 */
import type { FxRef, PriceRef } from '@reconcil/core';
import { chainEvents, externalRecords, fxRates, matches, priceSnapshots, tokens } from '@reconcil/db';
import { deriveRecordStatus, type DerivedRecordStatus } from '@reconcil/recon';
import { and, eq, sql } from 'drizzle-orm';

import type { TxContext } from '../context.js';
import { ToolError } from '../errors.js';

/** The leg is actioned on the human's behalf; the context carries no user id yet. */
const ACTOR = 'agent';

export interface MatchDecisionParams {
  matchId: string;
  decision: 'confirmed' | 'rejected';
  // The optional `note` is not threaded here: it is audited by the handler via the
  // tool_call args (persistToolCall), never stored on the row — no repo seam needed.
}

export interface MatchDecisionResult {
  matchId: string;
  status: 'confirmed' | 'rejected';
  recordStatus: DerivedRecordStatus;
  valuation: { fiatValue: string; priceRef?: PriceRef; fxRef?: FxRef };
}

/**
 * Apply one match decision inside an already-open SERIALIZABLE transaction (the caller,
 * runWriteTool, owns the transaction + serialization-failure retry, and persists the
 * tool_call in the same tx so the decision and its audit row commit atomically, C2). This
 * is the one place the cross-row matching invariants are enforced — see the file header.
 */
export async function decideMatchInTx(
  ctx: TxContext,
  params: MatchDecisionParams,
): Promise<MatchDecisionResult> {
  const { matchId, decision } = params;
  const tx = ctx.db;

  // 1. Load the leg, tenant-scoped. Missing or foreign → INVALID_INPUT (no leak
  //    of another tenant's ids).
  const [leg] = await tx
    .select({
      status: matches.status,
      externalRecordId: matches.externalRecordId,
      chainEventId: matches.chainEventId,
      amountAppliedRaw: matches.amountAppliedRaw,
      fiatValue: matches.fiatValue,
      priceSnapshotId: matches.priceSnapshotId,
      fxRateId: matches.fxRateId,
    })
    .from(matches)
    .where(and(eq(matches.tenantId, ctx.tenantId), eq(matches.id, matchId)))
    .limit(1);
  if (leg === undefined) throw new ToolError('INVALID_INPUT', `unknown match_id: ${matchId}`);

  // 2. Only a suggested leg may be actioned (idempotency guard for a late/repeat call).
  if (leg.status !== 'suggested') {
    throw new ToolError('NOT_SUGGESTED', `match ${matchId} is '${leg.status}', not 'suggested'`);
  }

  // 3. Parent record (tenant-scoped) for its amount/status.
  const [rec] = await tx
    .select({ id: externalRecords.id, amount: externalRecords.amount, status: externalRecords.status })
    .from(externalRecords)
    .where(and(eq(externalRecords.tenantId, ctx.tenantId), eq(externalRecords.id, leg.externalRecordId)))
    .limit(1);
  // The FK (ON DELETE CASCADE) guarantees a parent; absence would be data corruption.
  if (rec === undefined) throw new ToolError('INTERNAL', `match ${matchId} has no parent record`);

  // A voided record is manual/terminal: its status is never re-derived and the
  // output enum can't represent 'void', so neither decision is actionable. The
  // leg is legitimately 'suggested', so this is INVALID_INPUT (the record), not
  // NOT_SUGGESTED (the leg). A void operation owns cleanup of its own legs.
  if (rec.status === 'void') throw new ToolError('INVALID_INPUT', `match ${matchId} belongs to a void record`);

  if (decision === 'confirmed') {
    // 4. Invariant: Σ amount_applied_raw over the event's confirmed legs, plus this
    //    one, must not exceed the event amount. Checked over CONFIRMED legs (not
    //    all non-rejected) so a still-suggested competitor never blocks the first
    //    confirm — the over-applier is the one that trips the conflict.
    const [ev] = await tx
      .select({ amountRaw: chainEvents.amountRaw })
      .from(chainEvents)
      .where(eq(chainEvents.id, leg.chainEventId))
      .limit(1);
    if (ev === undefined) throw new ToolError('INTERNAL', `match ${matchId} references a missing event`);

    const [appliedRow] = await tx
      .select({ applied: sql<string>`coalesce(sum(${matches.amountAppliedRaw}), 0)::text` })
      .from(matches)
      .where(
        and(
          eq(matches.tenantId, ctx.tenantId),
          eq(matches.chainEventId, leg.chainEventId),
          eq(matches.status, 'confirmed'),
        ),
      );
    const applied = appliedRow?.applied ?? '0'; // aggregate: always one row, guard for types
    if (BigInt(applied) + leg.amountAppliedRaw > ev.amountRaw) {
      throw new ToolError(
        'MATCH_CONFLICT',
        `confirming match ${matchId} would apply ${BigInt(applied) + leg.amountAppliedRaw} base units to an event of ${ev.amountRaw}`,
      );
    }

    await tx
      .update(matches)
      .set({ status: 'confirmed', confirmedAt: new Date(), confirmedBy: ACTOR })
      .where(and(eq(matches.tenantId, ctx.tenantId), eq(matches.id, matchId)));
  } else {
    // Reject: nothing to check — a rejected leg is removed from every sum. The
    // confirmed_* columns double as the "actioned by/at" stamp.
    await tx
      .update(matches)
      .set({ status: 'rejected', confirmedAt: new Date(), confirmedBy: ACTOR })
      .where(and(eq(matches.tenantId, ctx.tenantId), eq(matches.id, matchId)));
  }

  // 5. Record status is a pure function of its confirmed legs' summed fiat value.
  const [fiatRow] = await tx
    .select({ fiat: sql<string>`coalesce(sum(${matches.fiatValue}), 0)::text` })
    .from(matches)
    .where(
      and(
        eq(matches.tenantId, ctx.tenantId),
        eq(matches.externalRecordId, rec.id),
        eq(matches.status, 'confirmed'),
      ),
    );
  // Design note (ADR-010): the band is the canonical DEFAULT tolerance, not the
  // suggest-time `tolerances` (a transient discovery param, not persisted). Status
  // is a deterministic accounting fact, reproducible from the leg + this policy.
  const recordStatus = deriveRecordStatus(rec.amount, fiatRow?.fiat ?? '0');

  // 6. Persist it. Void records were rejected above, so this write is unconditional.
  await tx
    .update(externalRecords)
    .set({ status: recordStatus })
    .where(and(eq(externalRecords.tenantId, ctx.tenantId), eq(externalRecords.id, rec.id)));

  // 7. Re-hydrate the pinned valuation refs (if any) for the decision envelope (C4). A
  //    stablecoin face-value leg has no pins → the refs stay absent.
  let priceRef: PriceRef | undefined;
  let fxRef: FxRef | undefined;
  if (leg.priceSnapshotId !== null) {
    const [snap] = await tx
      .select({
        id: priceSnapshots.id, tokenId: priceSnapshots.tokenId, priceDate: priceSnapshots.priceDate,
        currency: priceSnapshots.currency, price: priceSnapshots.price, source: priceSnapshots.source,
        symbol: tokens.symbolDisplay,
      })
      .from(priceSnapshots)
      .innerJoin(tokens, eq(tokens.id, priceSnapshots.tokenId))
      .where(eq(priceSnapshots.id, leg.priceSnapshotId))
      .limit(1);
    if (snap !== undefined) {
      priceRef = {
        snapshot_id: snap.id, token: snap.symbol ?? String(snap.tokenId), date: snap.priceDate,
        currency: snap.currency, source: snap.source, price: snap.price,
      };
    }
  }
  if (leg.fxRateId !== null) {
    const [fx] = await tx
      .select({
        id: fxRates.id, rateDate: fxRates.rateDate, base: fxRates.baseCurrency,
        quote: fxRates.quoteCurrency, rate: fxRates.rate, source: fxRates.source,
      })
      .from(fxRates)
      .where(eq(fxRates.id, leg.fxRateId))
      .limit(1);
    if (fx !== undefined) {
      fxRef = { fx_rate_id: fx.id, date: fx.rateDate, base: fx.base, quote: fx.quote, rate: fx.rate, source: fx.source };
    }
  }

  return {
    matchId,
    status: decision,
    recordStatus,
    valuation: { fiatValue: leg.fiatValue, ...(priceRef ? { priceRef } : {}), ...(fxRef ? { fxRef } : {}) },
  };
}
