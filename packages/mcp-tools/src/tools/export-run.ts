/**
 * Materialize a rendered export (contract §6.5): write the in-memory files to
 * `out_dir/<export_id>/`, register the `exports` row (status `done`, with the
 * audit manifest), validate the output against its contract, persist the
 * tool_call (C2) using the pre-minted id the manifest already cites, and return
 * the citation envelope. Export tools are non-read-only (they write files +
 * register a row) but never destructive. Shared by both Face A export tools.
 */
import { mkdir, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Warning } from '@reconcil/core';
import { exportsTable } from '@reconcil/db';
import { isZero, type RenderedExport, type RenderedFile } from '@reconcil/exporters';

import type { ToolContext } from '../context.js';
import type { ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { realpathAncestorWithinBase, realpathWithinBase, resolveWithinBase } from '../fs-confine.js';
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
  return baseDirUnder(exportRoot(), outDir);
}

/**
 * The same confinement, against a root the CALLER names. Module-private on purpose: an
 * exported `baseDir(outDir, root)` would let any future caller pick its own anchor —
 * `baseDir(agentSuppliedOutDir, '/')` confines to nothing — in the one helper whose entire
 * job is "which path is the trusted anchor". The parameter exists only so
 * `writeExportFiles` can read RECONCIL_EXPORT_DIR once and anchor both the validation and
 * the post-mkdir re-check to that same value.
 */
async function baseDirUnder(base: string, outDir?: string): Promise<string> {
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

/**
 * Create this export's `<exportId>/` directory under the confined base and write its files
 * into it. Shared by every export tool: `export_journal_drafts` used to carry its own copy
 * of this `mkdir`+`writeFile` pair, which meant the hardening below reached only the tools
 * routed through `runExport` while the register claimed the write path was covered.
 *
 * Three things beyond a plain write, all for the same co-resident-writer threat:
 *  - `baseDir` is computed once, OUTSIDE the try: it can throw INVALID_INPUT, and a second
 *    call inside the block would let that surface after `mkdir` had already succeeded, for
 *    a value the caller had already passed validation on;
 *  - after `mkdir -p`, the finished directory is re-resolved — `baseDir`'s check could only
 *    vouch for segments that existed then, and every segment created since, including
 *    `<exportId>/` itself, went unvalidated;
 *  - writes go through the RESOLVED directory with `{ flag: 'wx' }` — create, never follow
 *    or truncate. The directory is a fresh UUID, so anything already at that path was
 *    planted, and a plain `writeFile` would follow it straight out of the export root.
 *    Reported paths stay in the LOGICAL vocabulary (see below).
 */
export async function writeExportFiles(
  toolName: string,
  outDir: string | undefined,
  exportId: string,
  rendered: readonly RenderedFile[],
): Promise<{ dir: string; files: { name: string; path: string; sha256: string }[] }> {
  // Root read ONCE and passed into both users. `exportRoot()` reads the environment, and
  // the post-mkdir check below must be anchored to the same root `baseDir` validated
  // against; two independent reads could see a different RECONCIL_EXPORT_DIR (the export
  // tests mutate it), making the re-check either vacuous against a wider root or a spurious
  // INTERNAL against a narrower one. Passing it in is what enforces that — relying on the
  // two calls sharing a synchronous tick would be an invariant the next `await` breaks
  // silently.
  const root = exportRoot();
  const dir = join(await baseDirUnder(root, outDir), exportId);

  const files: { name: string; path: string; sha256: string }[] = [];
  try {
    await mkdir(dir, { recursive: true });
    // Anchored at the EXPORT ROOT, not at the out_dir-narrowed base. Anchoring at the base
    // makes the check self-referential and unable to detect the very escape it is for:
    // with out_dir 'june/close' and a symlink planted at <root>/june, realpath resolves
    // BOTH sides through that symlink — realBase '/elsewhere/close', realTarget
    // '/elsewhere/close/<uuid>' — and the prefix test passes. The root is the one path an
    // attacker inside the export tree cannot move. (Verified: the base-anchored form wrote
    // outside the root in a Linux container; see the branch's second review round.)
    const check = await realpathWithinBase(root, dir);
    if (!check.ok) {
      // `mkdir -p` already ran, so a link planted during that window got a real directory
      // created behind it, outside the root. No contents ever land there — that is what the
      // check buys — but leaving the directory is a free write for the attacker and an
      // orphan nobody reclaims (the next run mints a fresh exportId). Non-recursive rmdir:
      // it removes only an empty directory, so it cannot destroy anything that was already
      // there, and best-effort because failing to tidy up must not mask the refusal.
      await rmdir(dir).catch(() => { /* nothing to reclaim, or not ours to remove */ });
      throw new ToolError('INTERNAL', `${toolName} failed to write export files`);
    }
    const realDir = check.realTarget;
    for (const f of rendered) {
      // Written through the RESOLVED directory — that is the security property. REPORTED
      // under the logical one: an export root that is itself a symlink or bind-mount
      // (macOS /var → /private/var) would otherwise hand the operator, and the exports
      // row, paths that do not correspond to the root they configured. Both name the same
      // file; only one of them is the operator's own vocabulary.
      await writeFile(join(realDir, f.name), f.content, { flag: 'wx' });
      files.push({ name: f.name, path: join(dir, f.name), sha256: f.sha256 });
    }
    return { dir, files };
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError('INTERNAL', `${toolName} failed to write export files`, undefined, err);
  }
}

export async function runExport<T>(
  opts: ExportRunOptions,
  outputSchema: { parse: (v: unknown) => T },
): Promise<ToolEnvelope<T>> {
  const { ctx, data, rendered, provenance } = opts;

  const { dir, files } = await writeExportFiles(opts.toolName, opts.outDir, provenance.exportId, rendered.files);

  // Build + validate the output BEFORE any DB write, so a contract violation can't
  // leave an orphan `done` exports row (the files already on disk are harmless).
  const outputData = { export_id: provenance.exportId, kind: opts.kind, period: data.period, files };
  let validated: T;
  try {
    validated = outputSchema.parse(outputData);
  } catch (err) {
    throw new ToolError('INTERNAL', `${opts.toolName} produced an output that violates its contract`, undefined, err);
  }

  const residueWarnings: Warning[] = rendered.roundingResidues
    .filter((r) => !isZero(r.residue))
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
