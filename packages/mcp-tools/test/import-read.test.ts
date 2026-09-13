/**
 * `readImportFile`'s byte cap and descriptor discipline.
 *
 * The cap had no test at all, which is how it survived being advisory: the path was
 * resolved three separate times (realpath → stat → readFile), so the size checked and the
 * bytes consumed came from independent lookups. It is now one descriptor and a BOUNDED
 * read — `readFile()` follows to EOF, so a writer appending to the same inode between the
 * stat and the read would still have walked past it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../src/errors.js';
import { readImportFile } from '../src/recon/import-fs.js';

let dir: string;
const saved = { importDir: process.env.RECONCIL_IMPORT_DIR, maxBytes: process.env.RECONCIL_IMPORT_MAX_BYTES };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'import-read-'));
  process.env.RECONCIL_IMPORT_DIR = dir;
});
afterEach(async () => {
  if (saved.importDir === undefined) delete process.env.RECONCIL_IMPORT_DIR;
  else process.env.RECONCIL_IMPORT_DIR = saved.importDir;
  if (saved.maxBytes === undefined) delete process.env.RECONCIL_IMPORT_MAX_BYTES;
  else process.env.RECONCIL_IMPORT_MAX_BYTES = saved.maxBytes;
  await rm(dir, { recursive: true, force: true });
});

describe('readImportFile — byte cap', () => {
  it('reads a file under the cap, whole and unmodified', async () => {
    const body = 'external_ref,amount,currency\nINV-1,10.00,EUR\n';
    await writeFile(join(dir, 'ok.csv'), body);
    process.env.RECONCIL_IMPORT_MAX_BYTES = '1000';
    await expect(readImportFile('ok.csv')).resolves.toBe(body);
  });

  it('reads a file EXACTLY at the cap — the bound is inclusive', async () => {
    // The read buffer is cap+1 bytes precisely so "filled the budget" is distinguishable
    // from "there was more"; an off-by-one here would reject a legitimate file.
    process.env.RECONCIL_IMPORT_MAX_BYTES = '16';
    const body = 'x'.repeat(16);
    await writeFile(join(dir, 'exact.csv'), body);
    await expect(readImportFile('exact.csv')).resolves.toBe(body);
  });

  it('rejects one byte over the cap', async () => {
    process.env.RECONCIL_IMPORT_MAX_BYTES = '16';
    await writeFile(join(dir, 'over.csv'), 'x'.repeat(17));
    await expect(readImportFile('over.csv')).rejects.toThrow(/exceeds the 16-byte import limit/);
  });

  it('surfaces the cap as INVALID_INPUT, with no path in the message', async () => {
    process.env.RECONCIL_IMPORT_MAX_BYTES = '4';
    await writeFile(join(dir, 'big.csv'), 'xxxxxxxx');
    try {
      await readImportFile('big.csv');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('INVALID_INPUT');
      expect((err as ToolError).message).not.toContain(dir);
    }
  });

  it('rejects a DIRECTORY at the path rather than treating it as a zero-byte file', async () => {
    // The non-regular-file guard. A directory is the portable stand-in for the FIFO/socket
    // case: those also report size 0, sail past the cap, and then stream without bound.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'adir'));
    await expect(readImportFile('adir')).rejects.toThrow(ToolError);
  });

  it('is fail-closed when RECONCIL_IMPORT_DIR is unset', async () => {
    delete process.env.RECONCIL_IMPORT_DIR;
    await expect(readImportFile('anything.csv')).rejects.toThrow(/not configured/);
  });
});
