/**
 * `export_close_pack` (contract §6.5) — the monthly close bundle: 6 CSVs + an
 * audit manifest, written to disk and registered in `exports`. Composes ledger +
 * pricing via `computeCloseData`, renders through the pure `@pet-crypto/exporters`
 * layer (rounding happens there, ADR-004), and returns the citation envelope.
 * Non-read-only, never destructive (P8). The tool_call id is minted up front so
 * the manifest cites the same id the envelope carries (C2).
 */
import { randomUUID } from 'node:crypto';

import { exportClosePackInput, exportClosePackOutput, type ExportClosePackOutput } from '@pet-crypto/core';
import { renderClosePack } from '@pet-crypto/exporters';

import type { ToolContext } from '../context.js';
import type { ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { ulid } from '../ulid.js';
import { computeCloseData } from './close-pack-data.js';
import { runExport } from './export-run.js';

export const TOOL_NAME = 'export_close_pack';

export async function exportClosePack(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<ExportClosePackOutput>> {
  const parsed = exportClosePackInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const data = await computeCloseData(ctx, {
    month: input.month,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.client_id !== undefined ? { clientId: input.client_id } : {}),
    valuation: input.valuation,
  });

  const provenance = { exportId: randomUUID(), toolCallId: ulid(), generatedAt: new Date().toISOString() };
  const rendered = renderClosePack({
    period: data.period,
    currency: data.currency,
    scope: data.scope,
    balancesOpening: data.balancesOpening,
    balancesClosing: data.balancesClosing,
    transactions: data.transactions,
    gas: data.gas,
    counterparties: data.counterparties,
    journal: data.journal,
    provenance: {
      exportId: provenance.exportId,
      toolCallId: provenance.toolCallId,
      generatedAt: provenance.generatedAt,
      coverage: data.coverageRefs,
      priceRefs: data.priceRefs,
      fxRefs: data.fxRefs,
    },
  });

  return runExport<ExportClosePackOutput>(
    {
      ctx,
      toolName: TOOL_NAME,
      kind: 'close_pack',
      rawArgs: input as Record<string, unknown>,
      data,
      rendered,
      provenance,
      ...(input.out_dir !== undefined ? { outDir: input.out_dir } : {}),
    },
    exportClosePackOutput,
  );
}
