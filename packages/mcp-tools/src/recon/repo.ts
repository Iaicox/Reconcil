/**
 * Reconciliation storage (recon_*, §6.4). `importExternalRecords` writes invoice
 * drafts idempotently: re-importing the same CSV is a no-op via the
 * `(tenant, client, kind, source, external_ref)` unique index (NULLS NOT DISTINCT,
 * ADR-006) — existing refs are skipped and counted, never updated. Tenant identity
 * comes from `ctx` (ADR-012); `clientId` arrives already resolved to the tenant's own
 * (the caller runs `resolveClientId`, so a bad id is INVALID_INPUT, never a raw
 * uuid-cast error here). Raw `counterpartyName` is stored for audit and returned
 * as-is — the caller sanitizes it at the response edge (P7/ADR-011).
 */
import type { ExternalRecordDraft } from '@reconcil/recon';
import { externalRecords } from '@reconcil/db';

import type { DbContext } from '../context.js';

/** A persisted row echoed back to the tool (counterpartyName still raw). */
export interface ImportedRecord {
  id: string;
  externalRef: string;
  amount: string;
  currency: string;
  issuedOn: string | null;
  counterpartyName: string | null;
}

export interface ImportResult {
  inserted: ImportedRecord[];
  skippedDuplicates: number;
}

/** Idempotency key inside one import batch (tenant/client are fixed per call).
 *  JSON.stringify keeps the joiner unambiguous (and NUL-free) as `kind` grows. */
const dedupeKey = (d: ExternalRecordDraft): string => JSON.stringify([d.kind, d.source, d.externalRef]);

export async function importExternalRecords(
  ctx: DbContext,
  drafts: ExternalRecordDraft[],
  clientId: string | null,
): Promise<ImportResult> {
  // Collapse intra-file duplicates first (first row wins), so the DB insert never
  // sees the same key twice and the skipped count includes in-file repeats.
  const seen = new Set<string>();
  const unique: ExternalRecordDraft[] = [];
  let skippedDuplicates = 0;
  for (const d of drafts) {
    const key = dedupeKey(d);
    if (seen.has(key)) { skippedDuplicates += 1; continue; }
    seen.add(key);
    unique.push(d);
  }

  if (unique.length === 0) return { inserted: [], skippedDuplicates };

  const inserted = await ctx.db
    .insert(externalRecords)
    .values(
      unique.map((d) => ({
        tenantId: ctx.tenantId,
        clientId,
        kind: d.kind,
        direction: d.direction,
        source: d.source,
        externalRef: d.externalRef,
        counterpartyName: d.counterpartyName,
        amount: d.amount,
        currency: d.currency,
        vatRate: d.vatRate,
        vatAmount: d.vatAmount,
        issuedOn: d.issuedOn,
        dueOn: d.dueOn,
        expectedAddress: d.expectedAddress,
        payload: d.payload,
      })),
    )
    .onConflictDoNothing({
      target: [
        externalRecords.tenantId,
        externalRecords.clientId,
        externalRecords.kind,
        externalRecords.source,
        externalRecords.externalRef,
      ],
    })
    .returning({
      id: externalRecords.id,
      externalRef: externalRecords.externalRef,
      amount: externalRecords.amount,
      currency: externalRecords.currency,
      issuedOn: externalRecords.issuedOn,
      counterpartyName: externalRecords.counterpartyName,
    });

  // Rows the DB skipped as already-present are duplicates too.
  skippedDuplicates += unique.length - inserted.length;
  return { inserted, skippedDuplicates };
}
