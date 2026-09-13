/**
 * Materialize a rendered export (contract §6.5): write the in-memory files to
 * `out_dir/<export_id>/`, register the `exports` row (status `done`, with the
 * audit manifest), validate the output against its contract, persist the
 * tool_call (C2) using the pre-minted id the manifest already cites, and return
 * the citation envelope. Export tools are non-read-only (they write files +
 * register a row) but never destructive. Shared by both Face A export tools.
 */
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Warning } from '@reconcil/core';
import { exportsTable } from '@reconcil/db';
import { isZero, type RenderedExport, type RenderedFile } from '@reconcil/exporters';

import type { ToolContext } from '../context.js';
import type { ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { isSinglePathSegment, realpathAncestorWithinBase, realpathWithinBase, resolveWithinBase } from '../fs-confine.js';
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
 * Resolve `out_dir` to a directory confined under `base`. `out_dir` is a MODEL-CONTROLLED
 * tool argument (H2) and therefore hostile: it is a subpath *under* the base, never an
 * arbitrary write location. Absent, it is a no-op. Present, it must stay inside — an
 * absolute `out_dir` that happens to land inside is fine, but any `..` traversal or
 * absolute path that escapes throws `INVALID_INPUT` (mirrors the `recon_import_invoices`
 * `file_path` confinement, `../fs-confine.ts`). Enforced twice: a pure prefix check, then a
 * `realpath` re-check on the deepest existing ancestor (the target may not exist yet —
 * callers `mkdir -p` it right after). The error never echoes the resolved server path, only
 * the caller-supplied `out_dir` value, which the caller already knows.
 *
 * Module-private on purpose. An exported `baseDir(outDir, root)` would let any future
 * caller pick its own anchor — `baseDir(agentSuppliedOutDir, '/')` confines to nothing — in
 * the one helper whose entire job is "which path is the trusted anchor". The `base`
 * parameter exists only so `writeExportFiles` can read RECONCIL_EXPORT_DIR once and anchor
 * both the validation and the post-mkdir re-check to that same value. There used to be an
 * exported `baseDir(outDir?)` wrapper; once every export tool routed through
 * `writeExportFiles` it had no production caller, and the nine confinement assertions that
 * exercised it were testing a path the product did not take. They drive the writer now.
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
  // `exportId` becomes a path segment, so it is confined like any other caller-supplied
  // component. Every production caller passes randomUUID(), but this is an exported seam
  // and `writeExportFiles(tool, 'june/close', '../../elsewhere', …)` would otherwise land
  // outside the validated out_dir — still inside the root, so the post-mkdir check below
  // could not see it. Same argument that keeps the root parameter module-private, applied
  // to the other side of the join.
  // Names validated BEFORE any I/O — mkdir included. Checking them after `mkdir -p` left
  // an empty `<exportId>/` orphaned under the export root on a bad name: no `exports` row,
  // and a fresh uuid every retry so nothing ever reclaimed it. They need no filesystem to
  // check, so there is no reason for them to run after one has been touched.
  if (!isSinglePathSegment(exportId) || rendered.some((f) => !isSinglePathSegment(f.name))) {
    throw new ToolError('INTERNAL', `${toolName} failed to write export files`);
  }

  // Root read ONCE and passed into both users. `exportRoot()` reads the environment, and
  // the post-mkdir check below must be anchored to the same root `baseDirUnder` validated
  // against; two independent reads could see a different RECONCIL_EXPORT_DIR (the export
  // tests mutate it), making the re-check either vacuous against a wider root or a spurious
  // INTERNAL against a narrower one. Passing it in is what enforces that — relying on the
  // two calls sharing a synchronous tick would be an invariant the next `await` breaks
  // silently.
  const root = exportRoot();
  const base = await baseDirUnder(root, outDir);
  const dir = join(base, exportId);

  const files: { name: string; path: string; sha256: string }[] = [];
  try {
    await mkdir(dir, { recursive: true });
    // Two questions, not one. (a) Is the finished directory still inside the export ROOT?
    // Anchoring that at the out_dir-narrowed base instead makes the check self-referential
    // and blind to the escape it exists for: with out_dir 'june/close' and a link planted
    // at <root>/june, realpath resolves BOTH sides through it and the prefix test passes.
    // (Verified: the base-anchored form wrote outside the root in a Linux container.)
    // (b) Is it the SAME directory that was validated? Containment alone allows a link
    // planted during the mkdir window to redirect the write ELSEWHERE INSIDE the root —
    // another tenant's export folder — while the exports row and the tool response still
    // report the logical out_dir path, leaving an audit trail that points at a directory
    // holding none of the bytes. Equality against realpath(base)/exportId answers both.
    // Independent questions, one round of I/O.
    const [baseCheck, check] = await Promise.all([
      realpathWithinBase(root, base),
      realpathWithinBase(root, dir),
    ]);
    const expected = baseCheck.ok ? join(baseCheck.realTarget, exportId) : null;
    if (!check.ok || expected === null || check.realTarget !== expected) {
      // `mkdir -p` already ran, so a link planted in that window may have got a real
      // directory created behind it. Best-effort, and it removes AT MOST THE LEAF: a
      // non-recursive rmdir cannot take back the intermediate levels `mkdir -p` created,
      // and on POSIX it fails outright when the planted entry is itself a symlink
      // (ENOTDIR). No contents ever land there — that is what the check buys — so this is
      // tidying, not containment, and failing to tidy must never mask the refusal.
      await rmdir(dir).catch(() => { /* a link, or levels above it — not reclaimable here */ });
      // The escaped/unresolvable discriminant is kept as the CAUSE (server-side only; the
      // model still sees the generic INTERNAL, C6). "Somebody planted a link under the
      // export root" and "the directory vanished mid-write" are the same message otherwise.
      const why = !check.ok ? check.reason : 'redirected within the export root';
      throw new ToolError('INTERNAL', `${toolName} failed to write export files`, undefined, new Error(`export dir confinement failed: ${why}`));
    }
    const realDir = check.realTarget;
    // Independent writes, one round of I/O. Written through the RESOLVED directory — that
    // is the security property. REPORTED under the logical one: an export root that is
    // itself a symlink or bind-mount (macOS /var → /private/var) would otherwise hand the
    // operator, and the exports row, paths that do not correspond to the root they
    // configured. Both name the same file; only one is the operator's own vocabulary.
    const written = await Promise.allSettled(
      rendered.map(async (f) => {
        await writeFile(join(realDir, f.name), f.content, { flag: 'wx' });
        return { name: f.name, path: join(dir, f.name), sha256: f.sha256 };
      }),
    );
    const failure = written.find((r) => r.status === 'rejected');
    if (failure !== undefined) {
      // One write failing used to leave the others on disk with no `exports` row — a
      // half-written close pack the audit table has never heard of, and a fresh `<uuid>/`
      // every retry so it is never reclaimed. allSettled rather than all, so every write
      // has finished before the cleanup runs and nothing is still in flight behind it.
      //
      // Only the writes that SUCCEEDED are removed. Removing every rendered name would
      // delete whatever the failed write collided with — a file this code did not create
      // and has no business destroying, which is exactly what `wx` refused to overwrite one
      // line earlier. (Caught by its own test: the first draft deleted the squatter.)
      await Promise.all(
        written.flatMap((r, i) =>
          r.status === 'fulfilled'
            ? [rm(join(realDir, rendered[i]!.name), { force: true }).catch(() => { /* best effort */ })]
            : [],
        ),
      );
      await rmdir(dir).catch(() => { /* non-empty or gone — tidying, not containment */ });
      throw new ToolError('INTERNAL', `${toolName} failed to write export files`, undefined, failure.reason);
    }
    files.push(...written.map((r) => (r as PromiseFulfilledResult<{ name: string; path: string; sha256: string }>).value));
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
