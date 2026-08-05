/**
 * `baseDir` (export-run.ts) is pure filesystem math — no DB — so its confinement is tested
 * here, hermetically, against a real temp directory standing in for `RECONCIL_EXPORT_DIR`.
 * H2 (security): `out_dir` is a model-controlled tool argument and therefore hostile; it
 * must resolve to a subpath *under* the export root, never an arbitrary write location.
 * Mirrors `import-fs.test.ts` (the read-path counterpart) in shape and intent.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../src/errors.js';
import { baseDir } from '../src/tools/export-run.js';

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
