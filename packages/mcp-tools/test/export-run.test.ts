/**
 * `baseDir` (export-run.ts) is pure filesystem math — no DB — so its confinement is tested
 * here, hermetically, against a real temp directory standing in for `RECONCIL_EXPORT_DIR`.
 * H2 (security): `out_dir` is a model-controlled tool argument and therefore hostile; it
 * must resolve to a subpath *under* the export root, never an arbitrary write location.
 * Mirrors `import-fs.test.ts` (the read-path counterpart) in shape and intent.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../src/errors.js';
import { baseDir, writeExportFiles } from '../src/tools/export-run.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reconcil-export-root-'));
  process.env.RECONCIL_EXPORT_DIR = root;
});

afterEach(async () => {
  delete process.env.RECONCIL_EXPORT_DIR;
  await rm(root, { recursive: true, force: true });
});

describe('baseDir — export root confinement (security, H2)', () => {
  it('defaults to the configured export root when out_dir is absent', async () => {
    expect(await baseDir()).toBe(resolve(root));
  });

  it('resolves a relative out_dir as a subpath under the root', async () => {
    expect(await baseDir(join('june', 'close'))).toBe(resolve(root, 'june', 'close'));
  });

  it('accepts an absolute out_dir that happens to resolve inside the root', async () => {
    expect(await baseDir(root)).toBe(resolve(root));
  });

  it('rejects a parent-directory traversal', async () => {
    await expect(baseDir('../escape')).rejects.toBeInstanceOf(ToolError);
    await expect(baseDir('../escape')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects an absolute out_dir outside the root (the temp-dir root itself)', async () => {
    await expect(baseDir(tmpdir())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a sibling-prefix bypass (root + "-evil")', async () => {
    const evil = `..${sep}${basename(root)}-evil`;
    await expect(baseDir(evil)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('never leaks the resolved root path in the error, and hints at RECONCIL_EXPORT_DIR', async () => {
    let thrown: ToolError | undefined;
    try {
      await baseDir('../escape');
    } catch (err) {
      thrown = err as ToolError;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect(thrown?.message).not.toContain(resolve(root)); // no internal-path leak
    expect(thrown?.message).toContain('../escape'); // naming the supplied value is fine
    expect(thrown?.hint).toContain('RECONCIL_EXPORT_DIR');
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

  it('still writes normally when no link is in the way — the guard is not refusing everything', async () => {
    const { dir, files } = await writeExportFiles('export_close_pack', 'june/close', 'run-uuid', [file]);
    expect(dir).toBe(join(root, 'june', 'close', 'run-uuid'));
    expect(files[0]!.path).toBe(join(root, 'june', 'close', 'run-uuid', 'manifest.json'));
    await expect(readFile(files[0]!.path, 'utf8')).resolves.toBe(file.content);
  });
});
