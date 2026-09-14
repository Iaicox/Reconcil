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
import { realpath } from 'node:fs/promises';
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
 * Codes that mean the path simply is not there. Everything else a `realpath` can raise —
 * EACCES, EIO, ELOOP, EMFILE, or a non-errno like ERR_INVALID_ARG_VALUE — describes the
 * state of the filesystem rather than the shape of the path, and the caller cannot tell
 * from its side which it got. (EACCES is the interesting one: another path might well have
 * been readable, so "nothing you can do" is not strictly true — but "your path is wrong" is
 * false, and of the two available answers only one does not misdirect.)
 *
 * The distinction exists because callers turn it into an error CODE. Collapsing both into
 * one 'unresolvable' meant a permission-denied directory under the import root was reported
 * to the model as a bad `file_path` — advice to try another path, when no path would have
 * worked — and it made the read edge state one ownership rule (ADR-012 d7) and follow
 * another. Decided here rather than at the call site because this is the only place that
 * still has the error object; `reason` alone cannot carry it.
 */
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG']);

export type ConfinementFailure =
  | { ok: false; reason: 'missing' | 'escaped' }
  | { ok: false; reason: 'unreadable'; cause: unknown };

/**
 * Realpath both `base` and `target` and re-check confinement past symlinks. `target` must
 * already exist (the read-path shape: a file that is about to be read).
 *
 * Three distinct failures, because callers owe the caller three distinct answers:
 * `'missing'` — the path is not there, which is the supplied argument's own defect;
 * `'unreadable'` — it may well be there, but the filesystem would not say, which is not;
 * `'escaped'` — it resolved outside the base. The `unreadable` case carries the error so a
 * caller can log it server-side without it reaching the wire (C6).
 */
export async function realpathWithinBase(
  base: string,
  target: string,
): Promise<{ ok: true; realTarget: string } | ConfinementFailure> {
  let realBase: string;
  let realTarget: string;
  try {
    realBase = await realpath(base);
    realTarget = await realpath(target);
  } catch (err) {
    const code: unknown = (err as { code?: unknown })?.code;
    if (typeof code === 'string' && MISSING_CODES.has(code)) return { ok: false, reason: 'missing' };
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
