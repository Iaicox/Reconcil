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

import type { Warning } from '@reconcil/core';
import { exportsTable } from '@reconcil/db';
import type { RenderedExport } from '@reconcil/exporters';

import type { ToolContext } from '../context.js';
import type { ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { realpathAncestorWithinBase, resolveWithinBase } from '../fs-confine.js';
import { runWriteTool } from '../write-tx.js';
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

/** The operator-configured export root: `RECONCIL_EXPORT_DIR`, else `<cwd>/exports`. Unlike
 *  the import base dir this is NOT fail-closed — exports have always had a working default,
 *  and `out_dir` (below) only ever narrows a subpath under it, never replaces it. */
function exportRoot(): string {
  return resolve(process.env.RECONCIL_EXPORT_DIR ?? join(process.cwd(), 'exports'));
}

/**
 * Resolve the export root, confined to `exportRoot()`. `out_dir` is a MODEL-CONTROLLED tool
 * argument (H2) and therefore hostile: it is interpreted as a subpath *under* the base, never
 * as an arbitrary write location. Absent, it is a no-op (unchanged default behavior).
 * Present, it is resolved against the base and must stay inside it — an absolute `out_dir`
 * that happens to land inside the base is fine, but any `..` traversal or absolute path that
 * escapes it throws `INVALID_INPUT` (mirrors the `recon_import_invoices` `file_path`
 * confinement, `../fs-confine.ts`). Confinement is enforced twice: a pure prefix check, then
 * a `realpath` re-check on the deepest existing ancestor (the target directory itself may not
 * exist yet — callers `mkdir -p` it right after). Never echoes the resolved server path in
 * the error — only the caller-supplied `out_dir` value, which the caller already knows.
 */
export async function baseDir(outDir?: string): Promise<string> {
  const base = exportRoot();
  if (outDir === undefined) return base;

  const resolved = resolveWithinBase(base, outDir);
  const confined = resolved !== null && (await realpathAncestorWithinBase(base, resolved));
  if (resolved === null || !confined) {
    throw new ToolError(
      'INVALID_INPUT',
      `out_dir "${outDir}" resolves outside the export root`,
      'set RECONCIL_EXPORT_DIR to relocate the export root, or pass out_dir as a subpath under it',
    );
  }
  return resolved;
}

export async function runExport<T>(
  opts: ExportRunOptions,
  outputSchema: { parse: (v: unknown) => T },
): Promise<ToolEnvelope<T>> {
  const { ctx, data, rendered, provenance } = opts;
  const dir = join(await baseDir(opts.outDir), provenance.exportId);

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

  // Build + validate the output BEFORE any DB write, so a contract violation can't
  // leave an orphan `done` exports row (the files already on disk are harmless).
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

  // The `exports` registration and the tool_call audit row commit in one transaction (C2),
  // under the id the manifest already cites. The files are already on disk (best-effort); an
  // orphaned file dir from a rolled-back tx is harmless — the atomicity target is the two rows.
  // (On rollback the on-disk manifest cites a tool_call_id absent from `tool_calls`; expected,
  // since nothing reconciles disk manifests against the audit table.)
  return runWriteTool<T>(ctx, {
    toolName: opts.toolName,
    args: opts.rawArgs,
    toolCallId: provenance.toolCallId,
    body: async (txCtx) => {
      await txCtx.db.insert(exportsTable).values({
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

      return {
        data: validated,
        envelope: {
          coverage: data.coverageRefs,
          ...data.refsParts,
          priceRefs: data.priceRefs,
          fxRefs: data.fxRefs,
          warnings,
        },
      };
    },
  });
}
