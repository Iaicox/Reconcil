/**
 * `writeExportFiles` (export-run.ts) — the path every export tool takes — against a real
 * temp directory standing in for `RECONCIL_EXPORT_DIR`. No DB, but this is NOT pure path
 * math: it creates directories, plants junctions and writes real files, so a new case must
 * expect on-disk state (and `{ flag: 'wx' }` makes a second write to the same name a hard
 * EEXIST, not a silent overwrite).
 *
 * H2 (security): `out_dir` is a model-controlled tool argument and therefore hostile; it
 * must resolve to a subpath *under* the export root, never an arbitrary write location.
 * Mirrors `import-fs.test.ts` (the read-path counterpart) in intent.
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../src/errors.js';
import { writeExportFiles } from '../src/tools/export-run.js';

/**
 * The message the caller sees is generic by contract (C6) — every failure in this writer
 * reads "…failed to write export files" — so asserting on it cannot tell one refusal from
 * another. The server-side `cause` is what names the defect, and it is the only thing that
 * distinguishes a guard firing from `wx` raising EEXIST on the same path.
 */
async function causeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return ((err as ToolError).cause as Error | undefined)?.message ?? '(no cause)';
  }
  return '(resolved — expected a rejection)';
}

let root: string;

beforeEach(async () => {
  // REALPATH'd. `writeExportFiles` reports the resolved directory, so comparing its output
  // against a raw `mkdtemp` path is apples-to-oranges wherever the temp root is itself a
  // link: macOS `os.tmpdir()` is `/var/folders/…` with `/var -> /private/var`, and a CI
  // runner's `C:UsersRUNNER~1…` short name expands the same way. Without this the suite
  // is green only on machines whose temp dir happens to be already resolved — which is why
  // it passed locally and would not have on macOS.
  root = await realpath(await mkdtemp(join(tmpdir(), 'reconcil-export-root-')));
  process.env.RECONCIL_EXPORT_DIR = root;
});

const savedExportDir = process.env.RECONCIL_EXPORT_DIR;

afterEach(async () => {
  // Restored, not deleted. A developer with RECONCIL_EXPORT_DIR exported in their shell
  // would otherwise lose it for the rest of the worker, and any later test in that process
  // would silently fall back to <cwd>/exports and write into the repo. import-read.test.ts
  // saves and restores for the same reason — and its own comment records a leaked value
  // making a neighbouring test pass for the wrong reason.
  if (savedExportDir === undefined) delete process.env.RECONCIL_EXPORT_DIR;
  else process.env.RECONCIL_EXPORT_DIR = savedExportDir;
  await rm(root, { recursive: true, force: true });
});

/**
 * Driven through `writeExportFiles` — the path every export tool actually takes — rather
 * than through a `baseDir(outDir?)` wrapper. That wrapper existed only for these tests once
 * the tools were routed through the shared writer, so nine security assertions were
 * exercising code the product did not run; the wrapper is gone.
 */
describe('export root confinement, through the shipped writer (security, H2)', () => {
  const one = [{ name: 'manifest.json', content: '{}', sha256: 'x'.repeat(64) }];
  const write = (outDir?: string): Promise<{ dir: string }> =>
    writeExportFiles('export_close_pack', outDir, 'run-uuid', one);

  it('defaults to the configured export root when out_dir is absent', async () => {
    expect((await write()).dir).toBe(join(resolve(root), 'run-uuid'));
  });

  it('resolves a relative out_dir as a subpath under the root', async () => {
    expect((await write(join('june', 'close'))).dir).toBe(join(resolve(root), 'june', 'close', 'run-uuid'));
  });

  it('accepts an absolute out_dir that happens to resolve inside the root', async () => {
    expect((await write(root)).dir).toBe(join(resolve(root), 'run-uuid'));
  });

  it('rejects a parent-directory traversal', async () => {
    await expect(write('../escape')).rejects.toBeInstanceOf(ToolError);
    await expect(write('../escape')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects an absolute out_dir outside the root (the temp-dir root itself)', async () => {
    await expect(write(tmpdir())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a sibling-prefix bypass (root + "-evil")', async () => {
    await expect(write(`..${sep}${basename(root)}-evil`)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('never leaks the resolved root path in the error, and hints at RECONCIL_EXPORT_DIR', async () => {
    let thrown: ToolError | undefined;
    try {
      await write('../escape');
    } catch (err) {
      thrown = err as ToolError;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect(thrown?.message).not.toContain(resolve(root)); // no internal-path leak
    expect(thrown?.message).toContain('../escape'); // naming the supplied value is fine
    expect(thrown?.hint).toContain('RECONCIL_EXPORT_DIR');
  });

  it('refuses before creating anything — a rejected out_dir leaves no directory behind', async () => {
    await expect(write('../escape')).rejects.toThrow();
    await expect(readdir(join(root, '..', 'escape'))).rejects.toThrow(/ENOENT/);
  });
});

/**
 * The base-anchored escape, end to end through `writeExportFiles`.
 *
 * `fs-confine.test.ts` covers `realpathWithinBase` in isolation — including the anchoring
 * choice the second review round found, which it asserts as a difference. What was missing
 * was anyone driving the export WRITER against a planted link and checking that the bytes
 * stayed inside: the confinement helper being correct and the tool using it correctly are
 * two claims, and only the first had a test.
 *
 * Directory links are junctions: no elevation needed on Windows, and the type argument is
 * ignored elsewhere, so this runs on every platform rather than only on CI.
 */
describe('writeExportFiles — a symlinked out_dir SEGMENT cannot redirect the write', () => {
  const file = { name: 'manifest.json', content: '{"secret":"exported"}', sha256: 'x'.repeat(64) };

  it('refuses at VALIDATION when the link is already there, and writes nothing outside', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'reconcil-outside-'));
    try {
      // <root>/june -> <outside>. `out_dir: 'june/close'` then spells a path inside the
      // export root that resolves out of it. A link planted before the call is caught by
      // baseDir's own realpath-the-deepest-existing-ancestor check, so this is the FIRST
      // layer: INVALID_INPUT, before anything is created.
      await symlink(outside, join(root, 'june'), 'junction');
      await mkdir(join(outside, 'close'), { recursive: true });

      await expect(
        writeExportFiles('export_close_pack', 'june/close', 'run-uuid', [file]),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      // The bytes are the point: nothing of ours may exist under the escape target.
      expect(await readdir(join(outside, 'close'))).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses at the POST-MKDIR check when only the export dir itself is the link', async () => {
    // The second layer. Every segment baseDir can see is real and inside the root, so
    // validation passes; the link is the <exportId> directory itself, which `mkdir -p`
    // accepts as already existing, and only the post-mkdir re-resolve catches it.
    //
    // What this does NOT prove is the root-vs-base anchoring choice. Mutating
    // `realpathWithinBase(root, dir)` to the base-anchored form leaves this green: with the
    // link at <exportId>, the narrowed base still resolves inside while the target resolves
    // out, so both anchorings reject. The two differ only when a link sits in a SEGMENT of
    // out_dir — and any such link that exists at call time is already caught by the
    // validation layer above, so the difference is observable only for a link planted
    // DURING the mkdir window, which no static test can stage. That choice is pinned one
    // level down instead: fs-confine.test.ts asserts both halves explicitly (narrowed base
    // passes the escape, root rejects it).
    const outside = await mkdtemp(join(tmpdir(), 'reconcil-outside-'));
    try {
      await mkdir(join(root, 'june', 'close'), { recursive: true });
      await symlink(outside, join(root, 'june', 'close', 'run-uuid'), 'junction');

      await expect(
        writeExportFiles('export_close_pack', 'june/close', 'run-uuid', [file]),
      ).rejects.toMatchObject({ code: 'INTERNAL' });

      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('follows a link that stays inside the root, and REPORTS where the bytes went', async () => {
    // Policy: a link inside the export root is the operator's arrangement (`current ->
    // 2026-09` is a routine layout, and refusing every link broke it). What must not happen
    // is the audit trail lying about where the files are — so the `exports` row and the tool
    // response carry the RESOLVED path. A redirect is then permitted but never invisible.
    await mkdir(join(root, 'tenant-b', 'close'), { recursive: true });
    await symlink(join(root, 'tenant-b'), join(root, 'june'), 'junction');

    const r = await writeExportFiles('export_close_pack', join('june', 'close'), 'run-uuid', [file]);
    expect(r.dir).toBe(join(root, 'tenant-b', 'close', 'run-uuid'));
    expect(r.files[0]!.path).toBe(join(root, 'tenant-b', 'close', 'run-uuid', file.name));
    await expect(readFile(r.files[0]!.path, 'utf8')).resolves.toBe(file.content);
  });

  it('refuses a link that leaves the root, wherever on the path it sits', async () => {
    // The guarantee ADR-012 d7 makes: no export CONTENT outside the root. Staged at an
    // out_dir SEGMENT rather than at the export-id leaf, because a check anchored at the
    // narrowed base resolves both operands through the link and cannot see this at all.
    const outside = await mkdtemp(join(tmpdir(), 'reconcil-outside-'));
    try {
      await mkdir(join(outside, 'close'), { recursive: true });
      await symlink(outside, join(root, 'june'), 'junction');

      await expect(
        writeExportFiles('export_close_pack', join('june', 'close'), 'run-uuid', [file]),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      expect(await readdir(join(outside, 'close'))).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses an exportId that is not a single path segment', async () => {
    // The other side of the join. Every production caller passes randomUUID(), but this is
    // an exported seam, and a traversing exportId lands outside the validated out_dir while
    // staying inside the root — where a containment check cannot see it.
    for (const bad of ['../../elsewhere', 'a/b', '..', '.', '']) {
      await expect(
        writeExportFiles('export_close_pack', 'june/close', bad, [file]),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
    }
    // …and nothing was created for any of them.
    await expect(readdir(join(root, 'elsewhere'))).rejects.toThrow(/ENOENT/);
  });

  it('refuses a rendered file name that is not a single segment', async () => {
    // The other side of the join from exportId. '../manifest.json' writes outside the
    // per-export directory the confinement check just validated, while files[].path still
    // reports it as inside — and `wx` gives no protection, because the traversed target is
    // a fresh name.
    await expect(
      writeExportFiles('export_close_pack', 'june/close', 'run-uuid', [
        { name: `..${sep}escaped.json`, content: '{}', sha256: 'x'.repeat(64) },
      ]),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    await expect(readFile(join(root, 'june', 'close', 'escaped.json'), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('refuses two rendered files that want the same name, before touching the disk', async () => {
    // Left to run, one write wins and the other comes back EEXIST — inside a freshly minted
    // UUID directory, which is the one place EEXIST is supposed to mean "a co-resident
    // writer planted this". A renderer emitting the name twice would raise that alarm about
    // itself, and the INTERNAL cause the operator reads cannot tell the two apart.
    await expect(
      writeExportFiles('export_close_pack', 'june/close', 'dupe-uuid', [
        { name: 'manifest.json', content: '{"a":1}', sha256: 'a'.repeat(64) },
        { name: 'manifest.json', content: '{"b":2}', sha256: 'b'.repeat(64) },
      ]),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    // The CAUSE, not just the code. Both these assertions used to be satisfied by `wx`
    // alone — EEXIST lands in the same `ToolError('INTERNAL', …)` and its cleanup removes
    // the directory — so the test passed with the guard deleted, which is how a guard that
    // could never fire (`!seen.add(…)`: Set.add returns the Set) shipped green.
    await expect(causeOf(() => writeExportFiles('export_close_pack', 'june/close', 'dupe-uuid', [
      { name: 'manifest.json', content: '{"a":1}', sha256: 'a'.repeat(64) },
      { name: 'manifest.json', content: '{"b":2}', sha256: 'b'.repeat(64) },
    ]))).resolves.toMatch(/collide on name/);
    // Refused BEFORE mkdir, like the segment checks beside it. Asserted on `june` rather
    // than on the leaf: the leaf is also absent after the `wx` path's cleanup, so only the
    // un-created PARENT distinguishes "refused before any I/O" from "wrote, failed, tidied".
    await expect(readdir(join(root, 'june'))).rejects.toThrow(/ENOENT/);
  });

  it('refuses names that differ only in case — one file on Windows and macOS, two on Linux', async () => {
    // Not pedantry: written as-is, Linux materialises both and the other two hosts keep
    // whichever landed last, silently. The same export would not be the same export
    // depending on where it ran.
    await expect(
      writeExportFiles('export_close_pack', 'june/close', 'case-uuid', [
        { name: 'manifest.json', content: '{"a":1}', sha256: 'a'.repeat(64) },
        { name: 'Manifest.json', content: '{"b":2}', sha256: 'b'.repeat(64) },
      ]),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    // On a case-SENSITIVE filesystem (CI is ubuntu-latest/ext4) these are two paths, both
    // `wx` opens succeed and writeExportFiles RESOLVES — so without a working guard this
    // assertion is not merely weak, it is red. It passed on Windows only because NTFS folds
    // case and `wx` raised EEXIST for us.
    await expect(causeOf(() => writeExportFiles('export_close_pack', 'june/close', 'case-uuid', [
      { name: 'manifest.json', content: '{"a":1}', sha256: 'a'.repeat(64) },
      { name: 'Manifest.json', content: '{"b":2}', sha256: 'b'.repeat(64) },
    ]))).resolves.toMatch(/collide on name/);
    await expect(readdir(join(root, 'june'))).rejects.toThrow(/ENOENT/);
  });

  it('a failed write leaves no partial export behind', async () => {
    // One write failing used to leave the others on disk with no `exports` row — a
    // half-written close pack the audit table has never heard of, and a fresh <uuid>/ on
    // every retry so it was never reclaimed. The second file collides with something
    // already at its name, which is what `wx` is for.
    await mkdir(join(root, 'june', 'close', 'run-uuid'), { recursive: true });
    await writeFile(join(root, 'june', 'close', 'run-uuid', 'b.json'), 'squatted');

    await expect(
      writeExportFiles('export_close_pack', 'june/close', 'run-uuid', [
        { name: 'a.json', content: '{"a":1}', sha256: 'a'.repeat(64) },
        { name: 'b.json', content: '{"b":2}', sha256: 'b'.repeat(64) },
      ]),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    // a.json was written and must be gone; b.json was never ours and must be untouched.
    await expect(readFile(join(root, 'june', 'close', 'run-uuid', 'a.json'), 'utf8')).rejects.toThrow(/ENOENT/);
    await expect(readFile(join(root, 'june', 'close', 'run-uuid', 'b.json'), 'utf8')).resolves.toBe('squatted');
  });

  it('a rejected name creates no directory at all — validation runs before mkdir', async () => {
    // The name checks used to run AFTER `mkdir -p`, so a bad name left an empty <exportId>/
    // under the export root with no `exports` row — and a fresh uuid on every retry, so
    // nothing reclaimed it. They need no filesystem to perform, so they must not run after
    // one has been touched.
    await expect(
      writeExportFiles('export_close_pack', 'june/close', 'run-uuid', [
        { name: `..${sep}escaped.json`, content: '{}', sha256: 'x'.repeat(64) },
      ]),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    await expect(readdir(join(root, 'june', 'close'))).rejects.toThrow(/ENOENT/);
  });

  it('still accepts an export ROOT that is itself a link — the benign shape', async () => {
    // macOS /var -> /private/var, or a bind-mounted root. `realDir` differs from `dir` here
    // too, so an anchor that cannot tell the two apart would refuse every export on those
    // machines. The relative part is what distinguishes them: unchanged when the ROOT is
    // the link, changed when a segment inside it is.
    const outer = await mkdtemp(join(tmpdir(), 'reconcil-linked-root-'));
    try {
      const real = join(outer, 'real-exports');
      await mkdir(real, { recursive: true });
      const linked = join(outer, 'exports');
      await symlink(real, linked, 'junction');
      process.env.RECONCIL_EXPORT_DIR = linked;

      // Ids spelled out: deriving one from `outDir` puts a path separator in it, which the
      // single-segment guard correctly refuses — and the test would then pass for the wrong
      // reason on a line that is not the subject.
      for (const [outDir, id] of [[undefined, 'uuid-root'], [join('june', 'close'), 'uuid-sub']] as const) {
        const r = await writeExportFiles('export_close_pack', outDir, id, [file]);
        await expect(readFile(r.files[0]!.path, 'utf8')).resolves.toBe(file.content);
      }
    } finally {
      process.env.RECONCIL_EXPORT_DIR = root;
      await rm(outer, { recursive: true, force: true });
    }
  });

  it('accepts a differently-CASED out_dir for a directory that already exists', async () => {
    // The regression the previous anchor introduced on the main success path: it compared a
    // caller-spelled path against a realpath'd one, so on a case-insensitive filesystem
    // (Windows, default macOS) a second export under 'June/Close' after a first under
    // 'june/close' was refused as INTERNAL — a request that was entirely valid. Walking the
    // segments asks about LINKS and lets the OS resolve spelling, so casing is not part of
    // the answer.
    const first = await writeExportFiles('export_close_pack', join('june', 'close'), 'uuid-1', [file]);
    await expect(readFile(first.files[0]!.path, 'utf8')).resolves.toBe(file.content);

    const second = await writeExportFiles('export_close_pack', join('June', 'Close'), 'uuid-2', [file]);
    await expect(readFile(second.files[0]!.path, 'utf8')).resolves.toBe(file.content);
  });

  it('still writes normally when no link is in the way — the guard is not refusing everything', async () => {
    const { dir, files } = await writeExportFiles('export_close_pack', 'june/close', 'run-uuid', [file]);
    expect(dir).toBe(join(root, 'june', 'close', 'run-uuid'));
    expect(files[0]!.path).toBe(join(root, 'june', 'close', 'run-uuid', 'manifest.json'));
    await expect(readFile(files[0]!.path, 'utf8')).resolves.toBe(file.content);
  });
});
