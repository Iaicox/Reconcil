/**
 * Shared path-confinement math for tool arguments that select a filesystem location under
 * an operator-configured base directory: `RECONCIL_IMPORT_DIR` (reads, `recon/import-fs.ts`)
 * and `RECONCIL_EXPORT_DIR` (writes, `tools/export-run.ts`). Tool arguments are
 * agent-supplied and therefore hostile (H2) — an absolute path or `..` traversal must never
 * be allowed to pick a location outside the base. Confinement is enforced twice: a pure
 * `resolve`+prefix check (this module, no I/O), and a `realpath` re-check that defeats a
 * symlink planted inside an already-existing path segment (also here; two shapes, since
 * reads target a file that must already exist while writes target a directory that may not
 * exist yet). Callers own the domain-specific `ToolError` (message/hint differ per tool) —
 * this module never throws. Dependency-free (fs/promises + path only).
 */
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

/**
 * Is `name` a single, ordinary path segment — something that can be `join`ed onto a
 * confined directory without leaving it?
 *
 * `basename(x) === x` alone is not enough: `basename('..')` is `'..'`, so the traversal
 * passes and the join targets the PARENT of the validated directory. `''` and `'.'` both
 * resolve to the directory itself. All three have to be named.
 *
 * Lives here rather than inline at each call site because export-run.ts had the same
 * four-clause expression written out twice, each with its own copy of that `'..'`
 * rationale — and the next seam that joins a caller-supplied component would have had to
 * rediscover it.
 */
export function isSinglePathSegment(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && name === basename(name);
}

/**
 * Resolve `target` against `base`. Pure path math, no I/O. Returns the resolved absolute
 * path, or `null` if it would land outside `base` — an absolute `target` outside base, any
 * `..` traversal, or the base-prefix sibling bypass (`base` = `/srv/x`, target
 * `/srv/x-evil`). Equal to `base` itself is accepted (not an escape).
 */
export function resolveWithinBase(base: string, target: string): string | null {
  const resolved = resolve(base, target);
  if (resolved !== base && !resolved.startsWith(base + sep)) return null;
  return resolved;
}

/**
 * Codes that describe the SHAPE of the path that was asked for, rather than the state of
 * the filesystem it was asked about: absent, not a directory chain, too long to be a name,
 * or malformed (a NUL byte, which Node rejects in JS before any syscall). Whoever supplied
 * the path can fix all four by supplying a different one.
 *
 * Everything else a `realpath` can raise — EACCES, EIO, ELOOP, EMFILE — says the path may
 * be perfectly good and the filesystem will not say. ELOOP is the deliberate judgement in
 * that list: a symlink cycle IS deterministic per path, so by the letter of the rule above
 * it could be the caller's. It is not treated that way, because the cycle is an arrangement
 * somebody made inside the operator's directory, and telling the model "your path is wrong"
 * would send it hunting for a better one instead of surfacing a planted loop. (EACCES is the interesting one: another
 * path might well have been readable, so "nothing you can do" is not strictly true — but
 * "your path is wrong" is false, and of the two available answers only one misdirects.)
 *
 * The distinction exists because callers turn it into an error CODE, and one collapsed set
 * meant a permission-denied directory under the import root was reported to the model as a
 * bad `file_path` — advice to try another path, when no path would have worked.
 */
const PATH_SHAPE_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ERR_INVALID_ARG_VALUE']);

function isPathShapeFault(err: unknown): boolean {
  const code: unknown = (err as { code?: unknown })?.code;
  return typeof code === 'string' && PATH_SHAPE_CODES.has(code);
}

export type ConfinementFailure =
  | { ok: false; reason: 'bad-path' | 'escaped' }
  | { ok: false; reason: 'unreadable' | 'base-unusable'; cause: unknown };

/**
 * Realpath both `base` and `target` and re-check confinement past symlinks. `target` must
 * already exist (the read-path shape: a file that is about to be read).
 *
 * Four distinct failures, because they are owned by three different people:
 *  - `'bad-path'` — the supplied path is absent, malformed or not a directory chain;
 *  - `'escaped'` — it resolved outside the base;
 *  - `'unreadable'` — it may be there, but the filesystem would not say (EACCES, EIO, ELOOP);
 *  - `'base-unusable'` — the BASE is missing, or is not a directory, which is the
 *    operator's configuration and says nothing at all about `target`.
 *
 * The last one is why the two realpaths are no longer in one `try`, and why the base is
 * STATED to be a directory rather than inferred. Sharing a catch made a missing
 * RECONCIL_IMPORT_DIR come back as ENOENT and be read as "your file_path could not be
 * resolved". Splitting the catch fixed that case and left the neighbouring one: `realpath`
 * succeeds on a regular FILE, so a base pointing at one sailed through and the failure
 * surfaced as the TARGET's ENOTDIR — still in the shape codes, still blamed on the caller.
 *
 * That is the inference this function kept getting wrong. ENOTDIR was doing double duty —
 * "a component inside the base is a file" (the caller's) and "the base itself is a file"
 * (the operator's) — and no errno can separate those. One `stat` can, so one `stat` does,
 * and the code set below goes back to being a statement about the caller's path only.
 *
 * The two not-the-caller's cases carry the error so a caller can log it server-side without
 * it reaching the wire (C6).
 */
export async function realpathWithinBase(
  base: string,
  target: string,
): Promise<{ ok: true; realTarget: string } | ConfinementFailure> {
  let realBase: string;
  try {
    realBase = await realpath(base);
    // Positively checked, not inferred from what happens to `target` afterwards. `stat`
    // rather than `lstat`: a base that is a symlink to a directory is an ordinary operator
    // layout, and the export side honours exactly that shape.
    if (!(await stat(realBase)).isDirectory()) {
      return { ok: false, reason: 'base-unusable', cause: new Error('the configured base is not a directory') };
    }
  } catch (err) {
    return { ok: false, reason: 'base-unusable', cause: err };
  }

  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch (err) {
    if (isPathShapeFault(err)) return { ok: false, reason: 'bad-path' };
    return { ok: false, reason: 'unreadable', cause: err };
  }

  if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) {
    return { ok: false, reason: 'escaped' };
  }
  return { ok: true, realTarget };
}

/** Realpath of the deepest existing ancestor of `path` (itself, if it exists). Walks up via
 *  `dirname`; never throws — falls back to the root of the chain if nothing exists yet. */
async function realpathExistingAncestor(path: string): Promise<string> {
  let dir = path;
  for (;;) {
    try {
      return await realpath(dir);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return dir; // filesystem root; nothing on the chain resolves
      dir = parent;
    }
  }
}

/**
 * Realpath re-check for a `target` that may not exist yet (the write-path shape: the caller
 * is about to `mkdir -p` it). Realpaths the deepest existing ancestor of both `base` and
 * `target` and confirms the target's ancestor sits inside the base's ancestor — this defeats
 * a symlink planted inside an already-existing segment under `base`. A `target` with nothing
 * on disk yet (including `base` itself not existing) cannot have been redirected by a
 * symlink, so it is reported confined.
 */
export async function realpathAncestorWithinBase(base: string, target: string): Promise<boolean> {
  const [realBase, realTargetAncestor] = await Promise.all([
    realpathExistingAncestor(base),
    realpathExistingAncestor(target),
  ]);
  return realTargetAncestor === realBase || realTargetAncestor.startsWith(realBase + sep);
}
