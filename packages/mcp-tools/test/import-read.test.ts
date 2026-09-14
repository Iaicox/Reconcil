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
    await expect(readExactly(reader(['hello', '!!!']), 5)).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(readExactly(reader(['hello', '!!!']), 5)).rejects.toThrow(/changed while it was being read/);
  });

  it('refuses a file that SHRANK after the stat instead of returning a truncated CSV', async () => {
    // EOF arrives early. Returning buf.subarray(0, read) here is the silent-truncation bug:
    // a row cut mid-line imported as a success.
    await expect(readExactly(reader(['hel']), 5)).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(readExactly(reader(['hel']), 5)).rejects.toThrow(/changed while it was being read/);
  });

  it('reads an empty file as the empty string, not as a size mismatch', async () => {
    await expect(readExactly(reader([]), 0)).resolves.toBe('');
  });

  it('blames the server, not the caller — a mid-read mutation is not a bad file_path', async () => {
    // This assertion used to pin INVALID_INPUT. It was written to record the behaviour that
    // existed, not to argue for it, and the contract has since stated the opposite rule for
    // the symmetric case on the export side (§6.5): "a refusal the caller does NOT own … is
    // INTERNAL, not INVALID_INPUT: the caller's out_dir was already valid at that point, so
    // blaming it would be false."
    //
    // It is exactly that here. `file_path` passed confinement, passed realpath, and named a
    // regular file under the cap; then a co-resident writer — the threat this entire module
    // is built against — changed it underneath. INVALID_INPUT tells the agent to fix its
    // argument, and the only fix that shape suggests is trying a different path, which
    // cannot help. It also throws away the operator's one signal that someone is racing
    // writes in the import directory.
    for (const chunks of [['hello', '!'], ['hel']]) {
      await expect(readExactly(reader(chunks), 5)).rejects.toMatchObject({ code: 'INTERNAL' });
    }
  });

  it('keeps the underlying detail server-side, off the wire (C6)', async () => {
    // The cause says which direction it moved and by how much; the message the agent sees
    // says neither, and names no path.
    const err = await readExactly(reader(['hello', '!!!']), 5).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as ToolError,
    );
    expect(err.message).toBe('the import file changed while it was being read');
    expect((err.cause as Error).message).toMatch(/grew past the 5-byte size/);
  });
});

describe('readImportFile — a large cap is a configuration, not a fault', () => {
  it('serves an "effectively unlimited" cap for a small file', async () => {
    // The regression this replaces: an earlier version guarded the CAP against the largest
    // allocatable Buffer and refused EVERY call — a 45-byte CSV included — whenever the
    // operator set a very large limit. The cap sizes nothing; the FILE does.
    process.env.RECONCIL_IMPORT_MAX_BYTES = String(Number.MAX_SAFE_INTEGER);
    const body = 'external_ref,amount\nINV-1,10\n';
    await writeFile(join(dir, 'huge-cap.csv'), body);
    await expect(readImportFile('huge-cap.csv')).resolves.toBe(body);
  });

  it('still serves a large-but-ordinary cap rather than silently narrowing it', async () => {
    // The other regression: a 512 MB ceiling that fell back to the 8 MB default, so an
    // operator asking for 1 GB got 8 MB and a rejection naming a limit they never set.
    process.env.RECONCIL_IMPORT_MAX_BYTES = '1000000000';
    const body = 'external_ref,amount\nINV-2,20\n';
    await writeFile(join(dir, 'big-cap.csv'), body);
    await expect(readImportFile('big-cap.csv')).resolves.toBe(body);
  });
});

describe('readImportFile — who owns a failed read', () => {
  // The ownership rule (ADR-012 d7, 02-mcp-contracts.md §6.4) is stated as a principle, so
  // it has to hold for the ordinary fs faults too, not only for the mid-read mutation.
  //
  // Driven END TO END through readImportFile, not against an exported predicate. An earlier
  // version tested a classifier directly and left the WIRING — that the read path consults
  // it at all — pinned by nothing: restoring the collapse-everything behaviour kept the
  // whole suite green. A predicate nobody calls is not a guard.
  it('a path that is not there belongs to the caller — INVALID_INPUT', async () => {
    // The MESSAGE too, not only the code: several branches answer INVALID_INPUT here, so a
    // code-only assertion would go green even if the file-level beforeEach never ran — the
    // opposite of what this measures. It lands on the realpath branch, NOT on open(): a
    // missing file fails to resolve before a descriptor is ever asked for.
    await expect(readImportFile('no-such-file.csv')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'file_path could not be resolved in the import directory',
    });
  });

  it('a malformed path belongs to the caller too, not to the filesystem', async () => {
    // A NUL byte survives `path.resolve` (pure string math) and the prefix check, and is
    // refused by `realpath` in JS before any syscall. It describes the SHAPE of what was
    // asked for, so a different `file_path` fixes it — which is the definition this edge
    // uses for caller-owned. Answered INTERNAL for one round, which gave the two
    // malformed-argument codes (this and ENAMETOOLONG) opposite owners.
    await expect(readImportFile('a\0b.csv')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'file_path could not be resolved in the import directory',
    });
  });

  it('an unusable import ROOT is not reported as a bad file_path', async () => {
    // The inversion this round exists to fix, and it lived inside the check that prevents
    // it everywhere else: `realpath(base)` and `realpath(target)` shared one catch, so a
    // missing RECONCIL_IMPORT_DIR arrived as ENOENT and was read as "the path is not
    // there". The model was told its argument was wrong and would have retried other
    // paths, none of which could work.
    process.env.RECONCIL_IMPORT_DIR = join(dir, 'not-a-real-root');
    const err = await readImportFile('anything.csv').then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as ToolError,
    );
    expect(err.message).not.toContain('could not be resolved');
    expect(err.message).toMatch(/import directory cannot be used/);
    // It stays INVALID_INPUT — the documented exception, because the caller CAN act on it —
    // but the hint has to say HOW, or the code is just as misleading as the message was.
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.hint).toMatch(/content/);
    // The operator's fault is logged, never sent (C6).
    expect((err.cause as { code?: unknown } | undefined)?.code).toBe('ENOENT');
  });

  it('a directory is refused on its stat, not on its open — the ordering still holds', async () => {
    // `open(dir, 'r')` SUCCEEDS on all three platforms, so the non-regular-file guard is
    // what refuses it, and it is the caller's argument being described. Asserted because
    // the open() site is INTERNAL unconditionally now: if that guard ever moved after the
    // read, a directory would start reporting as a server fault.
    await mkdir(join(dir, 'a-directory'), { recursive: true });
    await expect(readImportFile('a-directory')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'file_path is not a regular file',
    });
  });
});
