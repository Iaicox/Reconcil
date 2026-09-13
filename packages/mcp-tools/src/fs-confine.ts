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
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
 * Realpath both `base` and `target` and re-check confinement past symlinks. `target` must
 * already exist (the read-path shape: a file that is about to be read). A path that cannot
 * be realpath'd (missing, permission error) is reported as `'unresolvable'` rather than
 * `'escaped'`, so callers can keep those as distinct error messages.
 */
export async function realpathWithinBase(
  base: string,
  target: string,
): Promise<{ ok: true; realTarget: string } | { ok: false; reason: 'unresolvable' | 'escaped' }> {
  let realBase: string;
  let realTarget: string;
  try {
    realBase = await realpath(base);
    realTarget = await realpath(target);
  } catch {
    return { ok: false, reason: 'unresolvable' };
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
 * Is every segment from `base` down to `target` a real directory entry — no link anywhere
 * on the way?
 *
 * This is the post-creation question, and it took three tries to state correctly. The
 * property wanted is "nothing redirected this path after we validated it", and the two
 * earlier spellings both got it wrong by comparing PATHS:
 *
 *  - anchored at the out_dir-narrowed base, both sides of the comparison resolved through
 *    the planted link, so it could not see an escape at all;
 *  - anchored at `realpath(root)` plus the relative path, it saw the escape but compared a
 *    caller-spelled string against a realpath'd one — so on a case-insensitive filesystem
 *    (Windows, default macOS) a second export under `June/Close` after a first under
 *    `june/close` was REFUSED, a legitimate request broken on the main success path.
 *
 * Walking the segments asks the question directly instead of encoding it in a string
 * comparison. `lstat` reports the entry itself rather than its target, Windows junctions
 * included (`isSymbolicLink()` is true for them), and path spelling is resolved by the OS,
 * so casing stops being part of the answer. A link ANYWHERE between base and target — the
 * out_dir segments and the per-export directory alike — is refused.
 *
 * `base` itself is not examined: the export root being a symlink or a bind-mount (macOS
 * `/var` → `/private/var`) is the operator's own configuration, not a redirect of the
 * caller's path.
 */
export async function isLinkFreeDescendant(base: string, target: string): Promise<boolean> {
  const rel = relative(base, target);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;

  let current = base;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    const entry = await lstat(current).catch(() => null);
    if (entry === null || entry.isSymbolicLink()) return false;
  }
  return true;
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
