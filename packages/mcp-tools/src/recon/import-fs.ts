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
import { constants as bufferConstants } from 'node:buffer';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ToolError } from '../errors.js';
import { realpathWithinBase, resolveWithinBase, type ConfinementFailure } from '../fs-confine.js';

/** Max bytes for a `file_path` import (operator knob; read at call time so it is
 *  configurable at runtime and testable). */
export function maxFileBytes(): number {
  const raw = Number(process.env.RECONCIL_IMPORT_MAX_BYTES);
  // Finite and positive, and NOT silently narrowed. An earlier version clamped this at
  // 512 MB and fell back to the 8 MB default when the operator asked for more — which
  // discarded a legitimate `RECONCIL_IMPORT_MAX_BYTES=1000000000` without a word and then
  // rejected a 40 MB file naming a limit nobody had configured.
  //
  // No upper clamp at all. The cap does not size anything — the read buffer is sized from
  // the file's own stat — so an "effectively unlimited" value is servable for every file
  // small enough to read, and refusing it here would kill the tool for a configuration that
  // works. The file being too large to allocate IS refused, loudly, at read time.
  return Number.isFinite(raw) && raw > 0 ? raw : 8_000_000;
}

/**
 * The largest file this can read. Bounded by MAX_STRING_LENGTH (~512 MB), not MAX_LENGTH
 * (~9e15): `readExactly` returns a STRING, so the buffer is not the binding constraint —
 * `buf.toString('utf8')` throws ERR_STRING_TOO_LONG long before `allocUnsafe` complains.
 * Anchoring on MAX_LENGTH made this guard unfireable: a 1 GB file passed it, allocated a
 * gigabyte, read the whole thing, and THEN threw into the generic catch as "file_path could
 * not be read" — the exact misdiagnosis the guard exists to prevent, after paying for it.
 */
const MAX_SERVABLE_SIZE = bufferConstants.MAX_STRING_LENGTH;

/**
 * The ownership rule, as a TABLE rather than as prose repeated in four places.
 *
 * It had been an if/if/ternary chain here, an unconditional INTERNAL below, a paragraph in
 * ADR-012 d7 and another in 02-mcp-contracts.md §6.4 — and three review rounds running found
 * a copy that had drifted from the others rather than a behaviour that was wrong. One copy,
 * and `Record<ConfinementFailure['reason'], …>` makes the compiler check that every member
 * of the union has an answer: a fifth reason added to fs-confine.ts will not build until it
 * is decided here.
 *
 * The rule itself: is the refusal a statement about the REQUEST, or about the condition of
 * the FILESYSTEM? Not about where in the sequence it happened — `!isFile()` and the byte cap
 * come later and are still the caller's.
 *
 * `base-unusable` is the one entry that is not decided by that rule, and it is worth being
 * explicit about why, because "the caller can act on it" is true of every failure here and
 * so cannot be the reason. It is this: the caller supplied `file_path`, the tool ALSO takes
 * `content`, and an import directory that cannot be used makes the whole `file_path` input
 * unavailable rather than any particular path wrong. INVALID_INPUT with a hint says exactly
 * that; INTERNAL would say "nothing you can do" about the one case where something can be.
 */
const CONFINEMENT_ERRORS: Record<
  ConfinementFailure['reason'],
  { code: 'INVALID_INPUT' | 'INTERNAL'; message: string; hint?: string }
> = {
  // About the request: absent, malformed, too long, or a component that is not a directory.
  'bad-path': { code: 'INVALID_INPUT', message: 'file_path could not be resolved in the import directory' },
  // About the request: it resolved, and it resolved somewhere it may not go.
  escaped: { code: 'INVALID_INPUT', message: 'file_path resolves outside the permitted import directory' },
  // About the filesystem: EACCES, EIO, ELOOP. The path may be perfectly good and it will
  // not say, so "try another path" is not a recovery.
  unreadable: { code: 'INTERNAL', message: 'the import file could not be read' },
  // About the operator's configuration, and about the `file_path` input as a whole.
  'base-unusable': {
    code: 'INVALID_INPUT',
    message: 'file_path import is unavailable (the configured import directory cannot be used)',
    hint: 'pass the CSV inline as `content`, or ask the operator to check RECONCIL_IMPORT_DIR',
  },
};

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

/** The subset of `FileHandle` `readExactly` needs — so the loop can be driven by a fake. */
export interface ByteReader {
  read(buf: Buffer, offset: number, length: number, position: null): Promise<{ bytesRead: number }>;
}

/**
 * Read exactly `size` bytes from `reader`, or refuse.
 *
 * Bounded, not `fh.readFile()`. The caller's `stat` is a snapshot: a co-resident writer can
 * append to the SAME inode between it and the read, and `readFile` follows to EOF, so the
 * byte cap would stay advisory for exactly the planted-file case it exists for.
 *
 * The buffer is sized from the FILE, not from the cap — sizing it `cap + 1` made a 45-byte
 * invoice CSV allocate 8 MB (above `Buffer.poolSize`, so a fresh un-pooled ArrayBuffer per
 * call, multiplied by concurrent imports). The one spare byte makes GROWTH observable, and
 * the final equality check makes SHRINKAGE observable: a short read means the writer
 * truncated or rewrote the inode, and returning the prefix would hand the parser a row cut
 * mid-line — 12 000 of 50 000 invoices — as a successful import. Both are the same event
 * and get the same answer.
 *
 * INTERNAL, not INVALID_INPUT — the same rule the export side already states (contract
 * §6.5): "a refusal the caller does NOT own … is INTERNAL, not INVALID_INPUT: the caller's
 * out_dir was already valid at that point, so blaming it would be false." A file that
 * changes between `stat` and the last byte is the co-resident WRITER this whole module is
 * built against; `file_path` was valid when it was checked and is still valid now. Telling
 * the agent its argument was bad invites the one recovery that cannot work — trying a
 * different path — and costs the operator the only signal that says someone is racing
 * writes in their import directory. The cause carries which direction it moved, server-side.
 *
 * Extracted and exported because it is the most intricate logic in this file and a real
 * mid-read mutation cannot be staged from a test: a fake `ByteReader` can.
 */
export async function readExactly(reader: ByteReader, size: number): Promise<string> {
  const buf = Buffer.allocUnsafe(size + 1);
  let read = 0;
  const mutated = (detail: string): ToolError =>
    new ToolError('INTERNAL', 'the import file changed while it was being read', undefined, new Error(detail));
  for (;;) {
    const { bytesRead } = await reader.read(buf, read, buf.length - read, null);
    if (bytesRead === 0) break;
    read += bytesRead;
    if (read > size) {
      throw mutated(`grew past the ${String(size)}-byte size it was stat'd at`);
    }
  }
  if (read !== size) {
    throw mutated(`stat'd at ${String(size)} bytes, read ${String(read)} — truncated or rewritten mid-read`);
  }
  return buf.subarray(0, read).toString('utf8');
}

/** Confine, defeat symlink escape, size-cap, then read. All errors are generic. */
export async function readImportFile(filePath: string): Promise<string> {
  const base = importBaseDir();
  if (base === null) {
    // INVALID_INPUT although the operator, not the caller, owns the configuration — the one
    // deliberate exception to the ownership rule, because the caller CAN act on it: the tool
    // takes `content` as well, and inline CSV needs no import directory. INTERNAL here would
    // say "nothing you can do" about the one refusal the model can route around.
    throw new ToolError('INVALID_INPUT', 'file_path import is not configured (set RECONCIL_IMPORT_DIR)');
  }
  const confined = resolveConfinedPath(base, filePath);

  const check = await realpathWithinBase(base, confined);
  if (!check.ok) {
    const { code, message, hint } = CONFINEMENT_ERRORS[check.reason];
    // The cause rides only on the two reasons that carry one; C6 keeps it server-side.
    throw new ToolError(code, message, hint, 'cause' in check ? check.cause : undefined);
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
  // INTERNAL unconditionally, with no errno inspection at all. `realpathWithinBase` above
  // has already established that this path EXISTS and resolves inside the base, so an
  // ENOENT here does not mean "the caller named something that is not there" — it means the
  // file went away between the two calls. That is the realpath→open race 09-known-gaps.md
  // documents, and ADR-012 d7 rules on it explicitly: a refusal the caller does not own is
  // INTERNAL. An errno split at this site got that exactly backwards for one round.
  //
  // The race is not the only way in, and a comment here once said it was. On POSIX,
  // `realpath` consults only SEARCH permission on the prefix, so a mode-000 file in a
  // readable directory resolves fine and then fails `open` with EACCES — no race at all.
  // (Not reproducible on Windows at all: `fs.chmod` there sets only the read-only
  // attribute, so neither call fails — which is why the tests for this are POSIX-only and
  // run on CI rather than on a developer's machine.) EMFILE and ENFILE arrive here the same
  // way. What makes one unconditional answer right for all of them is that none is a
  // statement about the argument.
  let fh;
  try {
    fh = await open(realTarget, 'r');
  } catch (err) {
    throw new ToolError('INTERNAL', 'the import file could not be read', undefined, err);
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
    // Checked on the FILE, not on the cap. The buffer is sized from `stats.size`, so a cap
    // of 1e16 meaning "effectively unlimited" is perfectly servable for a 45-byte CSV — an
    // earlier version guarded the CAP here and killed the tool outright for that config.
    // What is unservable is a FILE bigger than Node can allocate a Buffer for, and that is
    // the operator's storage, not the caller's path. Without this guard the failure lands in
    // the catch below as ERR_STRING_TOO_LONG from `buf.toString('utf8')` — NOT from
    // `allocUnsafe`, which happily allocates past the string limit; that is the whole reason
    // MAX_SERVABLE_SIZE is anchored on MAX_STRING_LENGTH, and a comment here asserted the
    // opposite. Either way it is INTERNAL now, so what this guard buys is the diagnosis: a
    // stated size and limit, rather than a generic read failure nobody can act on.
    if (stats.size > MAX_SERVABLE_SIZE) {
      throw new ToolError(
        'INTERNAL',
        'the import file is too large to read into memory',
        undefined,
        new Error(`file is ${String(stats.size)} bytes; the largest readable size is ${String(MAX_SERVABLE_SIZE)} (V8's max string length)`),
      );
    }

    // AWAITed, not returned bare: `return promise` inside a try/finally runs the finally —
    // and therefore fh.close() — before the promise settles, so the read lands on a closed
    // descriptor.
    return await readExactly(fh, stats.size);
  } catch (err) {
    // The cap and the non-regular-file refusal are ToolErrors already shaped for the caller.
    // Anything else reaching here is a fault on an ALREADY-OPEN descriptor — an EIO, a
    // failed Buffer allocation — which no `file_path` could have avoided, and whose text
    // must not leak (C6). Same reasoning as the open() site: past confinement, nothing here
    // is the argument's fault.
    if (err instanceof ToolError) throw err;
    throw new ToolError('INTERNAL', 'the import file could not be read', undefined, err);
  } finally {
    // Swallowed deliberately: a rejection from a `finally` REPLACES the outcome of the
    // try/catch, so an EIO on close would turn a fully-read CSV into a raw fs error, and
    // would overwrite the generic ToolError above with the underlying message this module
    // exists to keep off the wire (C6).
    await fh.close().catch(() => { /* the read already succeeded or already failed */ });
  }
}
