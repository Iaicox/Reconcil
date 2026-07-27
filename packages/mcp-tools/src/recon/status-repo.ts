/**
 * Reconciliation snapshot (recon_status, §6.4) — the authoritative read over Face B
 * state. Four tenant-scoped aggregates, computed in one `repeatable read` transaction
 * so the figures are mutually consistent (a status report must not mix snapshots):
 *
 *   - records:               count of external records per lifecycle status;
 *   - open_amounts:          outstanding (amount − Σ confirmed fiat) per currency,
 *                            over open/partial records only;
 *   - unmatched_settlements: settlement events with NO confirmed leg — the authoritative
 *                            count recon_suggest_matches defers to (its own can under-report);
 *   - overpayments:          the excess (Σ confirmed fiat − amount) per overpaid record.
 *
 * A settlement is a verified-stablecoin transfer with **exactly one** endpoint a tracked
 * (client-scoped) wallet — inbound receivable-settlements and outbound payable-settlements.
 * Internal wallet↔wallet transfers (both endpoints in scope) are NOT settlements and are
 * excluded via `externalCondition` (the shared, no-drift direction definition, scope-sql.ts);
 * an outbound flow with no matching payable legitimately stays counted (a real unreconciled
 * outflow). The count reflects ingested `chain_events`; its freshness is surfaced by the
 * caller via envelope coverage (getLedgerStatus).
 *
 * Period semantics: records filter on `issued_on` (parity with the matcher and the
 * `external_records_period_idx`); settlements filter on `block_time` via the shared
 * `periodRange`/`timeBetween`. `clientId` arrives already resolved to the tenant's own (the
 * caller runs `resolveClientId`); tenant identity always comes from `ctx` (ADR-006/012).
 * Only confirmed legs are real — suggested/rejected legs never move a figure here (P8).
 */
import { chainEvents, externalRecords, matches, tokens, wallets } from '@reconcil/db';
import { externalCondition, periodRange, timeBetween, transferKinds } from '@reconcil/ledger';
import { and, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';

import type { ToolContext } from '../context.js';

/** Records still carrying an outstanding balance (mutable array for drizzle inference). */
const OPEN_STATES: ('open' | 'partially_matched')[] = ['open', 'partially_matched'];

export interface ReconStatusParams {
  period?: { from: string; to: string };
  /** Resolved+validated client id to scope to; undefined = all of the tenant's data. */
  clientId?: string;
}

export interface ReconStatusResult {
  records: { open: number; partially_matched: number; matched: number; overpaid: number; void: number };
  openAmounts: { currency: string; value: string }[];
  unmatchedSettlements: { count: number; sample: { chainId: number; txHash: string; logIndex: number }[] };
  overpayments: { recordId: string; externalRef: string; excess: string; currency: string }[];
  /** The resolved settlement wallet set — the caller derives coverage/freshness over it. */
  addresses: string[];
}

export async function computeReconStatus(
  ctx: ToolContext,
  params: ReconStatusParams,
): Promise<ReconStatusResult> {
  const { period, clientId } = params;

  return ctx.db.transaction(
    async (tx) => {
      // Shared record filters: tenant, optional client, optional issued_on period.
      const recordScope = and(
        eq(externalRecords.tenantId, ctx.tenantId),
        clientId !== undefined ? eq(externalRecords.clientId, clientId) : undefined,
        period !== undefined ? gte(externalRecords.issuedOn, period.from) : undefined,
        period !== undefined ? lte(externalRecords.issuedOn, period.to) : undefined,
      );

      // 1. Record counts per status → a zeroed 5-key map (absent status stays 0).
      const statusRows = await tx
        .select({ status: externalRecords.status, count: sql<number>`count(*)::int` })
        .from(externalRecords)
        .where(recordScope)
        .groupBy(externalRecords.status);
      const records: ReconStatusResult['records'] = {
        open: 0, partially_matched: 0, matched: 0, overpaid: 0, void: 0,
      };
      for (const r of statusRows) records[r.status] = r.count;

      // 2. Outstanding open amounts per currency (amount − confirmed) over open/partial
      //    records. Money math stays in SQL (exact numeric, ADR-004); `::text` on the edge.
      const openRows = await tx
        .select({
          currency: externalRecords.currency,
          value: sql<string>`sum(${externalRecords.amount} - ${confirmedFiat(ctx.tenantId)})::text`,
        })
        .from(externalRecords)
        .where(and(recordScope, inArray(externalRecords.status, OPEN_STATES)))
        .groupBy(externalRecords.currency)
        .orderBy(externalRecords.currency);
      const openAmounts = openRows.map((r) => ({ currency: r.currency, value: r.value }));

      // 3. Overpayments: excess (confirmed − amount) per overpaid record.
      const overRows = await tx
        .select({
          recordId: externalRecords.id,
          externalRef: externalRecords.externalRef,
          currency: externalRecords.currency,
          excess: sql<string>`(${confirmedFiat(ctx.tenantId)} - ${externalRecords.amount})::text`,
        })
        .from(externalRecords)
        .where(and(recordScope, eq(externalRecords.status, 'overpaid')))
        .orderBy(externalRecords.externalRef);
      const overpayments = overRows.map((r) => ({
        recordId: r.recordId, externalRef: r.externalRef, excess: r.excess, currency: r.currency,
      }));

      // 4. Unmatched settlements: verified-stablecoin transfers touching the tenant's
      //    (client-scoped) wallets, in period, with no confirmed leg. Zero wallets → none.
      const walletRows = await tx
        .select({ address: wallets.address, clientId: wallets.clientId })
        .from(wallets)
        .where(eq(wallets.tenantId, ctx.tenantId));
      const scoped = clientId !== undefined ? walletRows.filter((w) => w.clientId === clientId) : walletRows;
      const addresses = [...new Set(scoped.map((w) => w.address))];

      let unmatchedSettlements: ReconStatusResult['unmatchedSettlements'] = { count: 0, sample: [] };
      if (addresses.length > 0) {
        const window = period !== undefined ? periodRange(period) : undefined;
        const settlementScope = and(
          // Exactly one endpoint in scope: inbound + outbound settlements, internal excluded.
          externalCondition(addresses, 'both'),
          transferKinds(), // erc20/native transfers only (gas etc. excluded)
          gt(chainEvents.amountRaw, 0n), // 0-value spam transfers settle nothing
          // Verified tokens only, NOT stablecoin-only — shares the matcher's widened candidate
          // gate (match-repo.ts) so "unmatched settlements" and "what suggest can match" stay
          // one definition (no drift); volatile settlements now count until confirmed.
          eq(tokens.verified, true),
          window !== undefined ? timeBetween(window.from, window.to) : undefined,
          sql`not exists (select 1 from ${matches} where ${matches.chainEventId} = ${chainEvents.id} and ${matches.tenantId} = ${ctx.tenantId} and ${matches.status} = 'confirmed')`,
        );

        const countRows = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(chainEvents)
          .innerJoin(tokens, eq(tokens.id, chainEvents.tokenId))
          .where(settlementScope);
        const sampleRows = await tx
          .select({ chainId: chainEvents.chainId, txHash: chainEvents.txHash, logIndex: chainEvents.logIndex })
          .from(chainEvents)
          .innerJoin(tokens, eq(tokens.id, chainEvents.tokenId))
          .where(settlementScope)
          .orderBy(chainEvents.blockTime, chainEvents.id)
          .limit(10);

        unmatchedSettlements = {
          count: countRows[0]?.count ?? 0,
          sample: sampleRows.map((e) => ({ chainId: e.chainId, txHash: e.txHash, logIndex: e.logIndex })),
        };
      }

      return { records, openAmounts, unmatchedSettlements, overpayments, addresses };
    },
    { isolationLevel: 'repeatable read' },
  );
}

/**
 * Correlated Σ of a record's confirmed-leg fiat (0 when none), tenant-scoped. Inlined
 * into the open-amount and overpayment expressions so the subtraction stays in numeric SQL.
 */
function confirmedFiat(tenantId: string) {
  return sql`coalesce((select sum(${matches.fiatValue}) from ${matches} where ${matches.externalRecordId} = ${externalRecords.id} and ${matches.tenantId} = ${tenantId} and ${matches.status} = 'confirmed'), 0)`;
}
