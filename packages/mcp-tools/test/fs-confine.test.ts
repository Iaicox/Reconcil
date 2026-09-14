/**
 * `realpathWithinBase` as the write path's SECOND confinement look, after `mkdir -p`.
 * (It was briefly wrapped in a `realpathDirWithinBase` helper that collapsed the
 * four-way discriminant this module exists to keep distinct — bad-path, escaped, unreadable
 * and base-unusable — for no gain over calling it directly.)
 *
 * `realpathAncestorWithinBase` runs before the directory exists, so it can only vouch for
 * the deepest ancestor present at that moment. Every segment created afterwards was never
 * checked, and a co-resident writer racing the mkdir can redirect one with a symlink. This
 * helper re-resolves the finished directory so the thing written into is the thing that was
 * validated.
 */
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** chmod means nothing on Windows, and nothing to root — under either, the permission test
 *  below would assert a refusal that never happens. */
const SKIP_PERMISSION_TEST = process.platform === 'win32' || process.getuid?.() === 0;

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
 * Directory links below are created as JUNCTIONS. A plain 'dir' symlink needs a privilege
 * Windows does not grant by default (EPERM), which had these cases — including the only
 * regression test for the base-anchored escape — skipping on every developer machine and
 * running solely on CI's Linux. A junction needs no elevation, resolves through `realpath`
 * the same way, and the type argument is ignored on every non-Windows platform.
 *
 * There is deliberately NO capability probe guarding them. A probe plus `it.runIf` plus an
 * assertion that the probe passed is two policies at once: on an environment that cannot
 * create links it produced one failure about a boolean and three SILENT skips, so the
 * reader saw a red run that said nothing about which security regressions went unexercised.
 * Letting the link cases fail directly on their own `symlink` call is the same signal with
 * the right name on it.
 */
describe('realpathWithinBase — the post-mkdir look on the write path', () => {
  it('accepts a real directory inside the base, returning the resolved path to write through', async () => {
    const dir = join(base, 'a', 'b');
    await mkdir(dir, { recursive: true });
    expect(await realpathWithinBase(base, dir)).toEqual({ ok: true, realTarget: await realpath(dir) });
  });

  it('accepts the base itself', async () => {
    expect(await realpathWithinBase(base, base)).toEqual({ ok: true, realTarget: await realpath(base) });
  });

  it('rejects a target that does not exist — removed underneath us is not writable', async () => {
    // The discriminant the dropped wrapper used to collapse: 'bad-path' (removed underneath
    // us) is a different fact from 'escaped' (below), and only one of them means somebody
    // tried something.
    expect(await realpathWithinBase(base, join(base, 'never-created'))).toEqual({ ok: false, reason: 'bad-path' });
  });

  it('blames the BASE when it is the base that will not resolve', async () => {
    // The two realpaths shared one `try` for a round, so a missing import/export root came
    // back as ENOENT and was read as "the target is not there" — the caller blamed for the
    // operator's configuration, inside the helper that exists to keep the two apart. The
    // target here is irrelevant and is never reached.
    const gone = join(root, 'no-such-root');
    const failure = await realpathWithinBase(gone, join(gone, 'anything'));
    expect(failure).toMatchObject({ ok: false, reason: 'base-unusable' });
    expect((failure as { cause?: { code?: unknown } }).cause?.code).toBe('ENOENT');
  });

  it('a malformed path belongs to the caller, not to the filesystem', async () => {
    // A NUL byte: `path.resolve` passes it through (pure string math), so it survives the
    // prefix check and reaches `realpath`, which rejects it in JS before any syscall. It
    // describes the SHAPE of what was asked for — a different path fixes it — so it belongs
    // with ENOENT, not with EACCES. Classified the other way for one round, which gave the
    // two malformed-argument codes opposite owners.
    expect(await realpathWithinBase(base, join(base, 'a\0b'))).toEqual({ ok: false, reason: 'bad-path' });
  });

  it.skipIf(SKIP_PERMISSION_TEST)('a target the filesystem will not resolve is not the caller argument', async () => {
    // POSIX and non-root, and it runs on CI (`test` is a bare ubuntu-latest job with no
    // `container:`, so it runs as `runner`). Dropping search permission on an intermediate
    // directory makes `realpath` fail EACCES for a path that may be perfectly good — the
    // case that must NOT come back as "your path is wrong".
    //
    // Skipped rather than faked where it cannot mean anything: Windows has no equivalent
    // `fs.chmod` can express, and root ignores the mode entirely — under either, the call
    // would SUCCEED and the assertion would go red for a reason that is not a defect. A
    // test that quietly exercises nothing is worse than one that says it did not.
    const locked = join(base, 'locked');
    await mkdir(join(locked, 'inner'), { recursive: true });
    await writeFile(join(locked, 'inner', 'f.csv'), 'x');
    await chmod(locked, 0o000);
    try {
      const failure = await realpathWithinBase(base, join(locked, 'inner', 'f.csv'));
      expect(failure).toMatchObject({ ok: false, reason: 'unreadable' });
      expect((failure as { cause?: { code?: unknown } }).cause?.code).toBe('EACCES');
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it('rejects a sibling whose path merely shares the base prefix', async () => {
    const evil = join(root, 'exports-evil');
    await mkdir(evil, { recursive: true });
    expect(await realpathWithinBase(base, evil)).toEqual({ ok: false, reason: 'escaped' });
  });

  it('rejects a symlink planted under the base that points outside it', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'evidence.txt'), 'x');

    // Exactly the race the second look exists for: the path is spelled inside the base,
    // and the pure prefix check passes, but it resolves out of it.
    const planted = join(base, 'run-uuid');
    await symlink(outside, planted, 'junction');

    expect(await realpathWithinBase(base, planted)).toEqual({ ok: false, reason: 'escaped' });
  });

  it('accepts a symlink under the base that points back inside it', async () => {
    const real = join(base, 'real');
    await mkdir(real, { recursive: true });
    const link = join(base, 'link');
    await symlink(real, link, 'junction');

    // …and it hands back the RESOLVED target, not the link, so the caller writes into the
    // real directory rather than re-traversing the symlink on every file.
    expect(await realpathWithinBase(base, link)).toEqual({ ok: true, realTarget: await realpath(real) });
  });
  it('rejects a target reached through a symlinked SEGMENT of the path, anchored at the root', async () => {
    // The shape that defeats a self-anchored check, and the reason callers must pass the
    // immovable export ROOT rather than an out_dir-narrowed base: if the base itself is
    // reached through the planted link, realpath resolves BOTH sides through it and the
    // prefix test passes on an escape.
    const outside = join(root, 'outside');
    await mkdir(join(outside, 'close'), { recursive: true });

    // <base>/june -> <root>/outside, so <base>/june/close resolves to <root>/outside/close.
    await symlink(outside, join(base, 'june'), 'junction');
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
