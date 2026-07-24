/**
 * Materialize a rendered export (contract §6.5): write the in-memory files to
 * `out_dir/<export_id>/`, register the `exports` row (status `done`, with the
 * audit manifest), validate the output against its contract, persist the
 * tool_call (C2) using the pre-minted id the manifest already cites, and return
 * the citation envelope. Export tools are non-read-only (they write files +
 * register a row) but never destructive. Shared by both Face A export tools.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Warning } from '@pet-crypto/core';
import { exportsTable } from '@pet-crypto/db';
import type { RenderedExport } from '@pet-crypto/exporters';

import type { ToolContext } from '../context.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { persistToolCall } from '../tool-calls.js';
import type { CloseData } from './close-pack-data.js';

export interface ExportRunOptions {
  ctx: ToolContext;
  toolName: string;
  kind: 'close_pack' | 'pdf_summary';
  rawArgs: Record<string, unknown>;
  data: CloseData;
  rendered: RenderedExport;
  provenance: { exportId: string; toolCallId: string; generatedAt: string };
  outDir?: string;
}

function baseDir(outDir?: string): string {
  // out_dir is operator-facing (self-host); the <export_id> subdir isolates runs.
  return resolve(outDir ?? process.env.PET_CRYPTO_EXPORT_DIR ?? join(process.cwd(), 'exports'));
}

export async function runExport<T>(
  opts: ExportRunOptions,
  outputSchema: { parse: (v: unknown) => T },
): Promise<ToolEnvelope<T>> {
  const { ctx, data, rendered, provenance } = opts;
  const dir = join(baseDir(opts.outDir), provenance.exportId);

  const files: { name: string; path: string; sha256: string }[] = [];
  try {
    await mkdir(dir, { recursive: true });
    for (const f of rendered.files) {
      const path = join(dir, f.name);
      await writeFile(path, f.content);
      files.push({ name: f.name, path, sha256: f.sha256 });
    }
  } catch (err) {
    throw new ToolError('INTERNAL', `${opts.toolName} failed to write export files: ${String(err)}`);
  }

  await ctx.db.insert(exportsTable).values({
    id: provenance.exportId,
    tenantId: ctx.tenantId,
    clientId: data.scope.clientId ?? null,
    kind: opts.kind,
    periodStart: data.period.start,
    periodEnd: data.period.end,
    params: opts.rawArgs,
    status: 'done',
    filePath: dir,
    manifest: rendered.manifest,
    completedAt: new Date(),
  });

  const outputData = { export_id: provenance.exportId, kind: opts.kind, period: data.period, files };
  let validated: T;
  try {
    validated = outputSchema.parse(outputData);
  } catch (err) {
    throw new ToolError('INTERNAL', `${opts.toolName} produced an output that violates its contract: ${String(err)}`);
  }

  const residueWarnings: Warning[] = rendered.roundingResidues
    .filter((r) => Number(r.residue) !== 0)
    .map((r) => ({
      code: 'ROUNDING_RESIDUE',
      message: `journal rounding residue ${r.residue} ${r.currency}`,
      context: { currency: r.currency, residue: r.residue },
    }));
  const warnings = [...data.warnings, ...residueWarnings];

  await persistToolCall(ctx, {
    id: provenance.toolCallId,
    toolName: opts.toolName,
    args: opts.rawArgs,
    coverage: data.coverageRefs,
    result: outputData,
  });

  return buildEnvelope(validated, {
    toolCallId: provenance.toolCallId,
    coverage: data.coverageRefs,
    ...data.refsParts,
    priceRefs: data.priceRefs,
    fxRefs: data.fxRefs,
    warnings,
  });
}
