/**
 * `readImportFile`'s byte cap and descriptor discipline.
 *
 * The cap had no test at all, which is how it survived being advisory: the path was
 * resolved three separate times (realpath → stat → readFile), so the size checked and the
 * bytes consumed came from independent lookups. It is now one descriptor and a BOUNDED
 * read — `readFile()` follows to EOF, so a writer appending to the same inode between the
 * stat and the read would still have walked past it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../src/errors.js';
import { readExactly, readImportFile } from '../src/recon/import-fs.js';

import type { ByteReader } from '../src/recon/import-fs.js';

let dir: string;
const saved = { importDir: process.env.RECONCIL_IMPORT_DIR, maxBytes: process.env.RECONCIL_IMPORT_MAX_BYTES };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'import-read-'));
  process.env.RECONCIL_IMPORT_DIR = dir;
  // Reset per test. Leaking a 4-byte cap out of the test above made the directory case
  // below pass on the SIZE check (a directory stats at 4096 on Linux) rather than on the
  // guard it names — a test that could not fail for its stated reason.
  delete process.env.RECONCIL_IMPORT_MAX_BYTES;
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
    // The cap is set LARGE and the message pinned on purpose: with a small cap a directory
    // (4096 bytes on Linux) trips the size check instead, and the test would stay green
    // with the guard deleted.
    process.env.RECONCIL_IMPORT_MAX_BYTES = '10000000';
    await mkdir(join(dir, 'adir'));
    await expect(readImportFile('adir')).rejects.toThrow(/not a regular file/);
  });

  it('is fail-closed when RECONCIL_IMPORT_DIR is unset', async () => {
    delete process.env.RECONCIL_IMPORT_DIR;
    await expect(readImportFile('anything.csv')).rejects.toThrow(/not configured/);
  });
});

/**
 * `readExactly` against a fake reader. The grow/shrink branches guard a real mid-read
 * mutation by a co-resident writer, which cannot be staged against a real file from a test —
 * so the loop is driven directly. Without these the two most intricate branches in the file
 * had no coverage at all, in a change whose own standard is that a guard no test can execute
 * is a guard nobody knows still works.
 */
function reader(chunks: readonly string[]): ByteReader {
  let i = 0;
  return {
    read(buf, offset, length) {
      const chunk = chunks[i];
      i += 1;
      if (chunk === undefined || chunk === '') return Promise.resolve({ bytesRead: 0 });
      const bytes = Buffer.from(chunk, 'utf8');
      // Honour `length` the way a real read does — overrunning the buffer would be the
      // fake's bug, not the subject's.
      const n = Math.min(bytes.length, length);
      bytes.copy(buf, offset, 0, n);
      return Promise.resolve({ bytesRead: n });
    },
  };
}

describe('readExactly', () => {
  it('returns the whole content when the file is exactly the size it was measured at', async () => {
    await expect(readExactly(reader(['hello']), 5)).resolves.toBe('hello');
  });

  it('reassembles across several short reads — one read is not guaranteed to fill the buffer', async () => {
    await expect(readExactly(reader(['he', 'l', 'lo']), 5)).resolves.toBe('hello');
  });

  it('refuses a file that GREW after the stat instead of returning a capped prefix', async () => {
    // The writer appended: more bytes arrive than were measured. The buffer's one spare
    // byte is what makes that observable at all.
    await expect(readExactly(reader(['hello', '!!!']), 5)).rejects.toThrow(/changed size while it was being read/);
  });

  it('refuses a file that SHRANK after the stat instead of returning a truncated CSV', async () => {
    // EOF arrives early. Returning buf.subarray(0, read) here is the silent-truncation bug:
    // a row cut mid-line imported as a success.
    await expect(readExactly(reader(['hel']), 5)).rejects.toThrow(/changed size while it was being read/);
  });

  it('reads an empty file as the empty string, not as a size mismatch', async () => {
    await expect(readExactly(reader([]), 0)).resolves.toBe('');
  });

  it('surfaces both mutations as INVALID_INPUT, never as an internal fault', async () => {
    for (const chunks of [['hello', '!'], ['hel']]) {
      await expect(readExactly(reader(chunks), 5)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });
});
