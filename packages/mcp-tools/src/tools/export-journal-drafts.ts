/**
 * `export_journal_drafts` (contract §6.5) — the recon-backed journal export: turn the
 * period's CONFIRMED matches (P8: never suggested) into a single QBO/Xero manual-journal
 * CSV DRAFT, written to disk and registered in `exports`. Composes the confirmed-leg read
 * (`computeJournalData`) with the pure `@reconcil/exporters` renderer (rounding + VAT split
 * happen there, ADR-004) and returns the citation envelope. Non-read-only, never
 * destructive. The export/tool_call ids are minted up front so the manifest cites the same
 * id the envelope carries (C2).
 *
 * H11: `computeJournalData` collects each confirmed leg's pinned (nullable)
 * `price_snapshot_id`/`fx_rate_id` and its settlement event ref; this handler hydrates the
 * distinct pinned ids into real `price_refs`/`fx_refs` (reusing the hydration
 * decision-repo.ts's confirm/reject envelope already uses, `pricing-refs.ts`) and cites the
 * backing events (`event_refs`/`event_ref_summary`, drilldown = analytics_list_events over
 * the journal's own period + client scope, mirroring recon_status). A same-currency
 * stablecoin leg pins neither id (face value at peg, P5), so a stablecoin-only journal
 * correctly ships empty price/fx refs — only a volatile-token leg contributes them.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { exportJournalDraftsInput, exportJournalDraftsOutput, type ExportJournalDraftsOutput, type Warning } from '@reconcil/core';
import { exportsTable } from '@reconcil/db';
import { renderJournalDrafts } from '@reconcil/exporters';

import type { ToolContext } from '../context.js';
import type { ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { hydrateFxRefs, hydratePriceRefs } from '../pricing-refs.js';
import { selectRefs } from '../refs.js';
import { ulid } from '../ulid.js';
import { runWriteTool } from '../write-tx.js';
import { baseDir } from './export-run.js';
import { computeJournalData } from './journal-drafts-data.js';

export const TOOL_NAME = 'export_journal_drafts';

export async function exportJournalDrafts(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<ExportJournalDraftsOutput>> {
  const parsed = exportJournalDraftsInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const data = await computeJournalData(ctx, {
    period: input.period,
    ...(input.client_id !== undefined ? { clientId: input.client_id } : {}),
  });

  // H11: hydrate the price/FX snapshots pinned on any volatile-token confirmed leg (C4).
  // A stablecoin-only journal collects no ids, so both stay empty — correctly, not by omission.
  const [priceRefMap, fxRefMap] = await Promise.all([
    hydratePriceRefs(ctx.db, data.priceSnapshotIds),
    hydrateFxRefs(ctx.db, data.fxRateIds),
  ]);
  const priceRefs = [...priceRefMap.values()];
  const fxRefs = [...fxRefMap.values()];

  // Cite the backing settlement events (C3): inline when ≤ cap, else a summary whose
  // drilldown re-enumerates them via analytics_list_events over this journal's own period
  // + the CANONICAL resolved client scope when present (mirrors recon_status's shape).
  const refsParts = selectRefs(
    [{ refs: data.eventRefs, totalCount: data.eventRefs.length }],
    {
      tool: 'analytics_list_events',
      args: {
        ...(data.scope.clientId != null ? { scope: { client_id: data.scope.clientId } } : {}),
        period: input.period,
      },
    },
  );

  const exportId = randomUUID();
  const toolCallId = ulid();
  const rendered = renderJournalDrafts({
    target: input.target,
    period: { start: input.period.from, end: input.period.to },
    scope: data.scope,
    entries: data.entries,
    ...(input.account_mapping !== undefined ? { accountMapping: input.account_mapping } : {}),
    provenance: {
      exportId,
      toolCallId,
      generatedAt: new Date().toISOString(),
      coverage: data.coverageRefs,
      priceRefs,
      fxRefs,
    },
  });

  // Materialize the single CSV under out_dir/<export_id>/ (the subdir isolates runs).
  const dir = join(baseDir(input.out_dir), exportId);
  const filePath = join(dir, rendered.file.name);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, rendered.file.content);
  } catch (err) {
    throw new ToolError('INTERNAL', `${TOOL_NAME} failed to write the journal file: ${String(err)}`);
  }

  // Validate the output BEFORE the DB write, so a contract violation can't leave an
  // orphan `done` exports row (the file already on disk is harmless).
  const outputData = {
    export_id: exportId,
    file: { name: rendered.file.name, path: filePath, sha256: rendered.file.sha256 },
    lines: rendered.lines,
    unmapped_categories: rendered.unmappedCategories,
    balanced: true as const,
  };
  let validated: ExportJournalDraftsOutput;
  try {
    validated = exportJournalDraftsOutput.parse(outputData);
  } catch (err) {
    throw new ToolError('INTERNAL', `${TOOL_NAME} produced an output that violates its contract: ${String(err)}`);
  }

  const residueWarnings: Warning[] = rendered.roundingResidues
    .filter((r) => Number(r.residue) !== 0)
    .map((r) => ({
      code: 'ROUNDING_RESIDUE',
      message: `journal rounding residue ${r.residue} ${r.currency}`,
      context: { currency: r.currency, residue: r.residue },
    }));
  const warnings = [...data.coverageWarnings, ...residueWarnings];

  // The `exports` registration and the tool_call audit row commit in one transaction (C2),
  // under the up-front id the manifest cites. The file is already on disk (best-effort); on
  // rollback its manifest cites a tool_call_id absent from `tool_calls` (expected — nothing
  // reconciles disk manifests against the audit table).
  return runWriteTool<ExportJournalDraftsOutput>(ctx, {
    toolName: TOOL_NAME,
    args: input as Record<string, unknown>,
    toolCallId,
    body: async (txCtx) => {
      await txCtx.db.insert(exportsTable).values({
        id: exportId,
        tenantId: ctx.tenantId,
        clientId: data.scope.clientId ?? null,
        kind: input.target === 'qbo' ? 'journal_qbo' : 'journal_xero',
        periodStart: input.period.from,
        periodEnd: input.period.to,
        params: input as Record<string, unknown>,
        status: 'done',
        filePath: dir,
        manifest: rendered.manifest,
        completedAt: new Date(),
      });

      return { data: validated, envelope: { coverage: data.coverageRefs, ...refsParts, priceRefs, fxRefs, warnings } };
    },
  });
}
