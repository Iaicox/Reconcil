/**
 * `export_pdf_summary` (contract §6.5) — a one-page PDF of the month's headline
 * figures + an audit manifest. Reuses `computeCloseData` (identical figures to
 * the close pack), renders through the pure `@reconcil/exporters` layer, and
 * returns the citation envelope. Non-read-only, never destructive (P8).
 */
import { randomUUID } from 'node:crypto';

import { exportPdfSummaryInput, exportPdfSummaryOutput, type ExportPdfSummaryOutput } from '@reconcil/core';
import { renderPdfSummary } from '@reconcil/exporters';

import type { ToolContext } from '../context.js';
import type { ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { ulid } from '../ulid.js';
import { computeCloseData } from './close-pack-data.js';
import { runExport } from './export-run.js';

export const TOOL_NAME = 'export_pdf_summary';

export async function exportPdfSummary(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<ExportPdfSummaryOutput>> {
  const parsed = exportPdfSummaryInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const data = await computeCloseData(ctx, {
    month: input.month,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.client_id !== undefined ? { clientId: input.client_id } : {}),
    valuation: input.valuation,
  });

  const provenance = { exportId: randomUUID(), toolCallId: ulid(), generatedAt: new Date().toISOString() };
  const rendered = await renderPdfSummary({
    period: data.period,
    currency: data.currency,
    scope: data.scope,
    ...(data.openingTotalFiat !== undefined ? { openingTotalFiat: data.openingTotalFiat } : {}),
    ...(data.closingTotalFiat !== undefined ? { closingTotalFiat: data.closingTotalFiat } : {}),
    ...(data.netFlowsFiat !== undefined ? { netFlowsFiat: data.netFlowsFiat } : {}),
    ...(data.gasTotalFiat !== undefined ? { gasTotalFiat: data.gasTotalFiat } : {}),
    topCounterparties: data.topCounterparties.map((c) => ({ name: c.name, fiatTurnover: c.fiatTurnover })),
    provenance: {
      exportId: provenance.exportId,
      toolCallId: provenance.toolCallId,
      generatedAt: provenance.generatedAt,
      coverage: data.coverageRefs,
      priceRefs: data.priceRefs,
      fxRefs: data.fxRefs,
    },
  });

  return runExport<ExportPdfSummaryOutput>(
    {
      ctx,
      toolName: TOOL_NAME,
      kind: 'pdf_summary',
      rawArgs: input,
      data,
      rendered,
      provenance,
      ...(input.out_dir !== undefined ? { outDir: input.out_dir } : {}),
    },
    exportPdfSummaryOutput,
  );
}
