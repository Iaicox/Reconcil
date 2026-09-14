/**
 * `readImportFile`'s byte cap and descriptor discipline.
 *
 * The cap had no test at all, which is how it survived being advisory: the path was
 * resolved three separate times (realpath → stat → readFile), so the size checked and the
 * bytes consumed came from independent lookups. It is now one descriptor and a BOUNDED
 * read — `readFile()` follows to EOF, so a writer appending to the same inode between the
 * stat and the read would still have walked past it.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** chmod means nothing on Windows, and nothing to root — under either, the permission
 *  cases below would assert a refusal that never happens. */
const SKIP_PERMISSION_TESTS = process.platform === 'win32' || process.getuid?.() === 0;

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

  it('a component inside the base that is a FILE is the caller path, not a broken root', async () => {
    // ENOTDIR's old double duty, now separable: with the base positively stat'd as a
    // directory, a non-directory component can only be INSIDE it, which the caller chose.
    // Windows reports ENOENT for the same shape, so this assertion holds on either — but it
    // only EXERCISES ENOTDIR on POSIX. Removing ENOTDIR from the shape codes therefore
    // passes on a Windows dev box and fails on CI; that is stated here so the next reader
    // does not mutation-test it locally and conclude the assertion is dead.
    await writeFile(join(dir, 'a-file.csv'), 'x');
    await expect(readImportFile(join('a-file.csv', 'child.csv'))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'file_path could not be resolved in the import directory',
    });
  });

  it('an import ROOT that is a FILE is the operator config, and says so', async () => {
    // `realpath` succeeds on a regular file, so splitting the two realpaths was not enough:
    // a base pointing at a file sailed through and the failure surfaced as the TARGET's
    // ENOTDIR — a shape code, blamed on the caller, with no hint. No errno can separate
    // "the base is a file" from "something inside it is"; one stat can.
    const notADir = join(dir, 'root-is-a-file');
    await writeFile(notADir, 'x');
    process.env.RECONCIL_IMPORT_DIR = notADir;
    const err = await readImportFile('anything.csv').then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as ToolError,
    );
    expect(err.message).not.toContain('could not be resolved');
    expect(err.message).toMatch(/import directory cannot be used/);
    expect(err.hint).toMatch(/content/);
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

/**
 * The POSIX-only end-to-end cases, in one block so CI pins the WIRING even though a Windows
 * dev box cannot run them.
 *
 * This is the hole that kept reopening. A permission fault is the natural way to reach
 * `unreadable` and the `open()` catch, `fs.chmod` expresses nothing on Windows, so the
 * coverage kept being written against the helper instead — and each time, the mapping from
 * helper result to ToolError went unpinned. Round 20 even removed the one end-to-end pin
 * that existed, by reclassifying the NUL case it was riding on.
 *
 * Skipped under root as well as on Windows: root ignores the mode, the call would SUCCEED,
 * and the assertion would go red for something that is not a defect.
 */
describe.skipIf(SKIP_PERMISSION_TESTS)('readImportFile — permission faults (POSIX)', () => {
  it('an unreadable directory under the root is INTERNAL, not a bad file_path', async () => {
    // Dropping search permission on an intermediate directory makes `realpath` fail EACCES
    // for a path that may be perfectly good. Mutation target: flipping the `unreadable` row
    // of CONFINEMENT_ERRORS to INVALID_INPUT must fail here.
    const locked = join(dir, 'locked');
    await mkdir(join(locked, 'inner'), { recursive: true });
    await writeFile(join(locked, 'inner', 'f.csv'), 'a,b\n1,2\n');
    await chmod(locked, 0o000);
    try {
      const err = await readImportFile(join('locked', 'inner', 'f.csv')).then(
        () => { throw new Error('expected a rejection'); },
        (e: unknown) => e as ToolError,
      );
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toBe('the import file could not be read');
      expect((err.cause as { code?: unknown } | undefined)?.code).toBe('EACCES');
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it('an over-long component is a caller path fault — the last shape code with nothing on it', async () => {
    // NAME_MAX is 255 on Linux and macOS, so a 300-character component is ENAMETOOLONG.
    // Windows collapses it to ENOENT, which is why this lives in the POSIX block: it is the
    // only place the code can be reached as itself rather than as a synonym.
    await expect(readImportFile('x'.repeat(300))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'file_path could not be resolved in the import directory',
    });
  });

  it('an unreadable FILE reaches the open() catch, and that is INTERNAL too', async () => {
    // The site a comment claimed could only be reached by the realpath→open race. On POSIX
    // `realpath` consults only SEARCH permission on the prefix, so a mode-000 file in a
    // readable directory resolves fine and fails at `open` with EACCES — no race, and the
    // one branch in this module that had never been executed by anything.
    const f = join(dir, 'unreadable.csv');
    await writeFile(f, 'a,b\n1,2\n');
    await chmod(f, 0o000);
    try {
      const err = await readImportFile('unreadable.csv').then(
        () => { throw new Error('expected a rejection'); },
        (e: unknown) => e as ToolError,
      );
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toBe('the import file could not be read');
    } finally {
      await chmod(f, 0o600);
    }
  });
});
