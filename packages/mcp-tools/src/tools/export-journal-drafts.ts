/**
 * `export_journal_drafts` (contract §6.5) — the recon-backed journal export: turn the
 * period's CONFIRMED matches (P8: never suggested) into a single QBO/Xero manual-journal
 * CSV DRAFT, written to disk and registered in `exports`. Composes the confirmed-leg read
 * (`computeJournalData`) with the pure `@reconcil/exporters` renderer (rounding + VAT split
 * happen there, ADR-004) and returns the citation envelope. Non-read-only, never
 * destructive. The export/tool_call ids are minted up front so the manifest cites the same
 * id the envelope carries (C2).
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
      priceRefs: [],
      fxRefs: [],
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
  // under the up-front id the manifest cites. The file is already on disk (best-effort).
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

      return { data: validated, envelope: { coverage: data.coverageRefs, warnings } };
    },
  });
}
