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
import { dirname, resolve, sep } from 'node:path';

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
