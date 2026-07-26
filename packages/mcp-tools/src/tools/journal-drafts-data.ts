/**
 * Shared compute for `export_journal_drafts` (contract §6.5): the CONFIRMED-leg read
 * that feeds the recon-backed journal. One tenant-scoped query joins
 * `matches ⋈ external_records ⋈ chain_events`, keeping only `status = 'confirmed'`
 * legs whose settlement `block_time` falls in the period (the shared `periodRange`/
 * `timeBetween` window, so the axis matches the rest of the ledger). Each row becomes a
 * `JournalEntryInput`; the exporters layer does the 2dp rounding + VAT split (ADR-004).
 *
 * Valuation is the leg's stored fiat (face value pinned at confirm, P5) — no fresh
 * pricing pass, so the journal carries no price/fx refs. Coverage/freshness is derived
 * over the client-scoped wallet set (getLedgerStatus) and surfaced by the caller (C5).
 * `clientId` is resolved to the tenant's own (ADR-006); tenant identity is always `ctx`.
 */
import type { CoverageRef, Warning } from '@reconcil/core';
import { chainEvents, externalRecords, matches, wallets } from '@reconcil/db';
import { getLedgerStatus, periodRange, timeBetween } from '@reconcil/ledger';
import type { JournalEntryInput } from '@reconcil/exporters';
import { and, eq } from 'drizzle-orm';

import type { ToolContext } from '../context.js';
import { mapCoverage } from '../coverage.js';
import { resolveClientId } from '../scope.js';

export interface JournalDataInput {
  period: { from: string; to: string };
  clientId?: string;
}

export interface JournalData {
  entries: JournalEntryInput[];
  scope: { addresses: string[]; clientId: string | null };
  coverageRefs: CoverageRef[];
  coverageWarnings: Warning[];
}

export async function computeJournalData(ctx: ToolContext, input: JournalDataInput): Promise<JournalData> {
  const clientId = await resolveClientId(ctx, input.clientId);
  const window = periodRange(input.period);

  // Client-scoped wallet set → coverage/freshness of the chain data behind the legs.
  const walletRows = await ctx.db
    .select({ address: wallets.address, clientId: wallets.clientId })
    .from(wallets)
    .where(eq(wallets.tenantId, ctx.tenantId));
  const scoped = clientId != null ? walletRows.filter((w) => w.clientId === clientId) : walletRows;
  const addresses = [...new Set(scoped.map((w) => w.address))];

  const rows = await ctx.db
    .select({
      externalRef: externalRecords.externalRef,
      counterparty: externalRecords.counterpartyName,
      direction: externalRecords.direction,
      grossFiat: matches.fiatValue,
      currency: matches.fiatCurrency,
      vatRate: externalRecords.vatRate,
      blockTime: chainEvents.blockTime,
    })
    .from(matches)
    .innerJoin(externalRecords, eq(externalRecords.id, matches.externalRecordId))
    .innerJoin(chainEvents, eq(chainEvents.id, matches.chainEventId))
    .where(
      and(
        eq(matches.tenantId, ctx.tenantId),
        eq(matches.status, 'confirmed'),
        clientId != null ? eq(externalRecords.clientId, clientId) : undefined,
        timeBetween(window.from, window.to),
      ),
    )
    .orderBy(chainEvents.blockTime, matches.id);

  const entries: JournalEntryInput[] = rows.map((r) => ({
    externalRef: r.externalRef,
    counterparty: r.counterparty ?? '',
    direction: r.direction,
    grossFiat: r.grossFiat,
    currency: r.currency,
    vatRate: r.vatRate != null ? Number(r.vatRate) : null,
    date: r.blockTime.toISOString().slice(0, 10),
  }));

  const coverage = await getLedgerStatus(ctx.db, { addresses });
  const { coverageRefs, coverageWarnings } = mapCoverage(coverage);

  return { entries, scope: { addresses, clientId }, coverageRefs, coverageWarnings };
}
