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
import { open } from 'node:fs/promises';
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

  // ONE open, then stat and read through that descriptor. The previous shape resolved the
  // path three separate times — realpath, stat, readFile — so the size cap measured one
  // inode and the read consumed whatever the path pointed at by then. A co-resident writer
  // swapping a path component between the stat and the read walked straight past the
  // 8 MB cap, which is the one thing that cap exists to prevent. `fh.stat()` reports the
  // descriptor's own inode, and the read below is bounded rather than read-to-EOF, so
  // neither a different inode nor growth of the same one can get past the cap. (The realpath→open window remains and is the residual TOCTOU noted
  // in 09-known-gaps.md; closing it needs an O_NOFOLLOW-per-segment walk, which is a
  // different slice. This removes the window that had an actual consequence.)
  let fh;
  try {
    fh = await open(realTarget, 'r');
  } catch {
    throw new ToolError('INVALID_INPUT', 'file_path could not be read from the import directory');
  }
  try {
    const cap = maxFileBytes();
    const stats = await fh.stat();
    // Regular files only. A FIFO, socket or device node reports size 0, which sails past
    // the cap below and then streams without bound into readFile — so the cap would be
    // guarding nothing at all for exactly the planted-file case it exists for. (The open()
    // above can also block forever on a writer-less FIFO, consuming one of libuv's four
    // threadpool threads; four of those wedge every filesystem operation in the process.
    // That window is not closed here — it needs O_NONBLOCK, which Node's promises API does
    // not expose — but a non-regular file is refused the moment it is observable.)
    if (!stats.isFile()) {
      throw new ToolError('INVALID_INPUT', 'file_path is not a regular file');
    }
    if (stats.size > cap) {
      throw new ToolError('INVALID_INPUT', `file exceeds the ${String(cap)}-byte import limit`);
    }

    // Bounded read, not `fh.readFile()`. The stat above is a snapshot: a co-resident writer
    // can append to the SAME inode between it and the read, and readFile follows to EOF, so
    // the cap would still be advisory for exactly the planted-file case it exists for. Read
    // at most cap+1 bytes into a fixed buffer — the extra byte is what distinguishes "filled
    // the budget exactly" from "there was more", without ever allocating more than the cap.
    const buf = Buffer.allocUnsafe(cap + 1);
    let read = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, read, buf.length - read, null);
      if (bytesRead === 0) break;
      read += bytesRead;
      if (read > cap) {
        throw new ToolError('INVALID_INPUT', `file exceeds the ${String(cap)}-byte import limit`);
      }
    }
    return buf.subarray(0, read).toString('utf8');
  } catch (err) {
    // The cap is a ToolError already shaped for the caller; anything else is an fs fault
    // whose text must not leak (C6).
    if (err instanceof ToolError) throw err;
    throw new ToolError('INVALID_INPUT', 'file_path could not be read from the import directory');
  } finally {
    // Swallowed deliberately: a rejection from a `finally` REPLACES the outcome of the
    // try/catch, so an EIO on close would turn a fully-read CSV into a raw fs error, and
    // would overwrite the generic ToolError above with the underlying message this module
    // exists to keep off the wire (C6).
    await fh.close().catch(() => { /* the read already succeeded or already failed */ });
  }
}
