import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withTempExportDir } from '../src/evals/export-dir.js';

// A scratch root under the OS tmp dir, isolated per test so `readdirSync` assertions on "no
// orphaned dir" can't be confused by anything else already in the real tmp dir.
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reconcil-export-dir-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('withTempExportDir', () => {
  it('creates a dir, hands it to fn, and removes it after fn resolves', async () => {
    let seen: string | undefined;
    const result = await withTempExportDir(root, (dir) => {
      seen = dir;
      expect(existsSync(dir)).toBe(true);
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(seen).toBeDefined();
    expect(existsSync(seen!)).toBe(false);
    // Nothing orphaned in the scratch root either.
    expect(readdirSync(root)).toEqual([]);
  });

  it('still removes the dir when fn throws after using it', async () => {
    let seen: string | undefined;
    await expect(
      withTempExportDir(root, (dir) => {
        seen = dir;
        return Promise.reject(new Error('provisioning failed'));
      }),
    ).rejects.toThrow('provisioning failed');
    expect(existsSync(seen!)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('leaves nothing orphaned when a failure happens before provisioning ever touches the dir', async () => {
    // Models run.ts's real shape: the dir is created, then a later step (DB provisioning)
    // fails before writing anything into it — the dir itself must still be reclaimed.
    await expect(
      withTempExportDir(root, () => Promise.reject(new Error('DB provisioning failed'))),
    ).rejects.toThrow('DB provisioning failed');
    expect(readdirSync(root)).toEqual([]);
  });

  it('does not throw when the dir was never created (mkdtemp itself fails)', async () => {
    // Point tmpRoot at a path that cannot contain a new dir — mkdtempSync throws before fn
    // ever runs. The finally must recognise "never created" and no-op rather than throwing
    // on rmSync(undefined-ish path).
    const missingRoot = join(root, 'does-not-exist');
    await expect(withTempExportDir(missingRoot, () => Promise.resolve('unreachable'))).rejects.toThrow();
  });
});
