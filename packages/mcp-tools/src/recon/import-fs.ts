/**
 * Filesystem edge for `recon_import_invoices`' `file_path` input. `file_path` is a
 * hostile, agent-supplied string, so reads are confined to an operator-configured
 * import directory (`RECONCIL_IMPORT_DIR`) — using the same confinement math the
 * exports write path uses (`../fs-confine.ts`). Reads are riskier than the exports
 * *write* path, so this is FAIL-CLOSED: with no `RECONCIL_IMPORT_DIR` set, `file_path`
 * is rejected outright. Containment is enforced twice — a pure `resolve`+prefix check
 * (rejects absolute paths and `..` traversal) and a post-`realpath` re-check (defeats
 * symlink escape) — plus a byte-size cap. Every failure returns a GENERIC message: the
 * path and the underlying fs error never leak back to the caller.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ToolError } from '../errors.js';
import { realpathWithinBase, resolveWithinBase } from '../fs-confine.js';

/** Max bytes for a `file_path` import (operator knob; read at call time so it is
 *  configurable at runtime and testable). */
export function maxFileBytes(): number {
  const raw = Number(process.env.RECONCIL_IMPORT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 8_000_000;
}

/** Resolved import base dir, or null when `file_path` import is not configured. */
export function importBaseDir(): string | null {
  const raw = process.env.RECONCIL_IMPORT_DIR;
  return raw === undefined || raw === '' ? null : resolve(raw);
}

/**
 * Resolve `filePath` strictly inside `base`. Pure (path math only). Throws
 * INVALID_INPUT — with no path in the message — for an absolute path or any `..`
 * escape. The `base + sep` guard also blocks the sibling-prefix bypass
 * (`base` = `/srv/imports`, target `/srv/imports-evil`).
 */
export function resolveConfinedPath(base: string, filePath: string): string {
  const target = resolveWithinBase(base, filePath);
  if (target === null) {
    throw new ToolError('INVALID_INPUT', 'file_path resolves outside the permitted import directory');
  }
  return target;
}

/** Confine, defeat symlink escape, size-cap, then read. All errors are generic. */
export async function readImportFile(filePath: string): Promise<string> {
  const base = importBaseDir();
  if (base === null) {
    throw new ToolError('INVALID_INPUT', 'file_path import is not configured (set RECONCIL_IMPORT_DIR)');
  }
  const confined = resolveConfinedPath(base, filePath);

  const check = await realpathWithinBase(base, confined);
  if (!check.ok) {
    throw new ToolError(
      'INVALID_INPUT',
      check.reason === 'unresolvable'
        ? 'file_path could not be resolved in the import directory'
        : 'file_path resolves outside the permitted import directory',
    );
  }
  const realTarget = check.realTarget;

  let size: number;
  try {
    size = (await stat(realTarget)).size;
  } catch {
    throw new ToolError('INVALID_INPUT', 'file_path could not be read from the import directory');
  }
  if (size > maxFileBytes()) {
    throw new ToolError('INVALID_INPUT', `file exceeds the ${String(maxFileBytes())}-byte import limit`);
  }

  try {
    return await readFile(realTarget, 'utf8');
  } catch {
    throw new ToolError('INVALID_INPUT', 'file_path could not be read from the import directory');
  }
}
