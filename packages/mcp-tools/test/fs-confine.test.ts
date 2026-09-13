/**
 * `realpathWithinBase` as the write path's SECOND confinement look, after `mkdir -p`.
 * (It was briefly wrapped in a `realpathDirWithinBase` helper that collapsed the
 * unresolvable/escaped discriminant this module exists to keep distinct, for no gain over
 * calling it directly.)
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

import { realpathWithinBase } from '../src/fs-confine.js';

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

describe('realpathWithinBase — the post-mkdir look on the write path', () => {
  it('accepts a real directory inside the base, returning the resolved path to write through', async () => {
    const dir = join(base, 'a', 'b');
    await mkdir(dir, { recursive: true });
    expect(await realpathWithinBase(base, dir)).toEqual({ ok: true, realTarget: await realpath(dir) });
  });

  it('accepts the base itself', async () => {
    expect(await realpathWithinBase(base, base)).toEqual({ ok: true, realTarget: await realpath(base) });
  });

  it('rejects a directory that does not exist — removed underneath us is not writable', async () => {
    // The discriminant the dropped wrapper used to collapse: 'unresolvable' (removed
    // underneath us) is a different fact from 'escaped' (below), and only one of them means
    // somebody tried something.
    expect(await realpathWithinBase(base, join(base, 'never-created'))).toEqual({ ok: false, reason: 'unresolvable' });
  });

  it('rejects a sibling whose path merely shares the base prefix', async () => {
    const evil = join(root, 'exports-evil');
    await mkdir(evil, { recursive: true });
    expect(await realpathWithinBase(base, evil)).toEqual({ ok: false, reason: 'escaped' });
  });

  it.runIf(symlinksWork)('rejects a symlink planted under the base that points outside it', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'evidence.txt'), 'x');

    // Exactly the race the second look exists for: the path is spelled inside the base,
    // and the pure prefix check passes, but it resolves out of it.
    const planted = join(base, 'run-uuid');
    await symlink(outside, planted, 'dir');

    expect(await realpathWithinBase(base, planted)).toEqual({ ok: false, reason: 'escaped' });
  });

  it.runIf(symlinksWork)('accepts a symlink under the base that points back inside it', async () => {
    const real = join(base, 'real');
    await mkdir(real, { recursive: true });
    const link = join(base, 'link');
    await symlink(real, link, 'dir');

    // …and it hands back the RESOLVED target, not the link, so the caller writes into the
    // real directory rather than re-traversing the symlink on every file.
    expect(await realpathWithinBase(base, link)).toEqual({ ok: true, realTarget: await realpath(real) });
  });
  it.runIf(symlinksWork)('rejects a target reached through a symlinked SEGMENT of the path, anchored at the root', async () => {
    // The shape that defeats a self-anchored check, and the reason callers must pass the
    // immovable export ROOT rather than an out_dir-narrowed base: if the base itself is
    // reached through the planted link, realpath resolves BOTH sides through it and the
    // prefix test passes on an escape.
    const outside = join(root, 'outside');
    await mkdir(join(outside, 'close'), { recursive: true });

    // <base>/june -> <root>/outside, so <base>/june/close resolves to <root>/outside/close.
    await symlink(outside, join(base, 'june'), 'dir');
    const narrowed = join(base, 'june', 'close');
    const target = join(narrowed, 'run-uuid');
    await mkdir(target, { recursive: true });

    // Anchored at the narrowed base — what the first version did — this WRONGLY passes:
    // both sides resolve into <root>/outside.
    expect(await realpathWithinBase(narrowed, target)).toMatchObject({ ok: true });
    // Anchored at the root, the escape is visible.
    expect(await realpathWithinBase(base, target)).toEqual({ ok: false, reason: 'escaped' });
  });
});
