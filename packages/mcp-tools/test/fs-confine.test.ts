/**
 * `realpathDirWithinBase` — the write path's SECOND confinement look, after `mkdir -p`.
 *
 * `realpathAncestorWithinBase` runs before the directory exists, so it can only vouch for
 * the deepest ancestor present at that moment. Every segment created afterwards was never
 * checked, and a co-resident writer racing the mkdir can redirect one with a symlink. This
 * helper re-resolves the finished directory so the thing written into is the thing that was
 * validated.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realpathDirWithinBase } from '../src/fs-confine.js';

let root: string;
let base: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'confine-'));
  base = join(root, 'exports');
  await mkdir(base, { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/**
 * Symlink creation needs a privilege Windows does not grant by default. Probed at MODULE
 * scope, not in a hook: `it.runIf` is evaluated while the file is being collected, which is
 * before any `beforeAll` has run — probing in a hook leaves the flag false and skips the
 * cases on every machine, including the ones that can run them. Wired into `it.runIf` so an
 * unprivileged machine reports them SKIPPED; an early `return` inside the body would report
 * them PASSED, which is the shape where a security test quietly stops testing anything.
 * CI is Linux, so these always run there.
 */
const symlinksWork = await (async (): Promise<boolean> => {
  const dir = await mkdtemp(join(tmpdir(), 'confine-probe-'));
  try {
    await symlink(dir, join(dir, 'probe'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

describe('realpathDirWithinBase', () => {
  it('accepts a real directory inside the base, returning the resolved path to write through', async () => {
    const dir = join(base, 'a', 'b');
    await mkdir(dir, { recursive: true });
    expect(await realpathDirWithinBase(base, dir)).toBe(await realpath(dir));
  });

  it('accepts the base itself', async () => {
    expect(await realpathDirWithinBase(base, base)).toBe(await realpath(base));
  });

  it('rejects a directory that does not exist — removed underneath us is not writable', async () => {
    expect(await realpathDirWithinBase(base, join(base, 'never-created'))).toBeNull();
  });

  it('rejects a sibling whose path merely shares the base prefix', async () => {
    const evil = join(root, 'exports-evil');
    await mkdir(evil, { recursive: true });
    expect(await realpathDirWithinBase(base, evil)).toBeNull();
  });

  it.runIf(symlinksWork)('rejects a symlink planted under the base that points outside it', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'evidence.txt'), 'x');

    // Exactly the race the second look exists for: the path is spelled inside the base,
    // and the pure prefix check passes, but it resolves out of it.
    const planted = join(base, 'run-uuid');
    await symlink(outside, planted, 'dir');

    expect(await realpathDirWithinBase(base, planted)).toBeNull();
  });

  it.runIf(symlinksWork)('accepts a symlink under the base that points back inside it', async () => {
    const real = join(base, 'real');
    await mkdir(real, { recursive: true });
    const link = join(base, 'link');
    await symlink(real, link, 'dir');

    // …and it hands back the RESOLVED target, not the link, so the caller writes into the
    // real directory rather than re-traversing the symlink on every file.
    expect(await realpathDirWithinBase(base, link)).toBe(await realpath(real));
  });
});
