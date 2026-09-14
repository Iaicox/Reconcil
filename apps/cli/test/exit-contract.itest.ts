/**
 * The exit-code contract, driven as a real process.
 *
 * Four review rounds churned on this — `process.exit` losing stderr, `process.exitCode`
 * being downgraded by an unhandled rejection, the contract being false for one of two
 * entrypoints — and every one of those was reasoned about in a comment that no test
 * executed. The branch's own standard is that a guard no test can execute is a guard nobody
 * knows still works, and this was the biggest instance of it left.
 *
 * A subprocess is the only way to observe an exit code, so this mirrors the shape
 * `scripts/check-no-signing-libs.test.cjs` already uses. Named `.itest.ts` because it spawns
 * processes rather than because it needs a database.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** tsx's PUBLISHED entry. Reaching into `node_modules/tsx/dist/cli.mjs` bound these tests to
 *  a path that is not part of its surface: a minor inside `^4.19.0` that relocates the file
 *  makes all six fail with an ENOENT the `catch` below flattens into "expected 2, got -1",
 *  saying nothing about the contract they measure. */
const TSX = createRequire(import.meta.url).resolve('tsx/cli');

/** The non-blank lines of a stderr blob — the "two-line shape" assertions compare against
 *  this rather than each splitting the string themselves. */
function reportLines(stderr: string): string[] {
  return stderr.trim().split('\n').filter((l) => l.trim() !== '');
}

interface Run { code: number; stderr: string; stdout: string }

/** Run a CLI entrypoint through tsx and report what the process actually did. */
function run(entry: string, args: string[], env: Record<string, string | undefined> = {}): Run {
  try {
    const stdout = execFileSync(
      process.execPath,
      [TSX, join(CLI_ROOT, 'src', entry), ...args],
      { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env }, cwd: CLI_ROOT },
    );
    return { code: 0, stderr: '', stdout };
  } catch (err) {
    const e = err as { status?: number; stderr?: string; stdout?: string };
    return { code: e.status ?? -1, stderr: String(e.stderr ?? ''), stdout: String(e.stdout ?? '') };
  }
}

describe('exit-code contract — 2 means the gate could not run', () => {
  it('a bad invocation exits 2 and says what is wrong', () => {
    const r = run('run.ts', ['--runs', '0'], { ANTHROPIC_API_KEY: 'sk-test' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('COULD NOT RUN');
    expect(r.stderr).toMatch(/positive integer/);
  }, 60_000);

  it('an unknown flag exits 2 rather than running the full suite', () => {
    const r = run('run.ts', ['--smoek'], { ANTHROPIC_API_KEY: 'sk-test' });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown argument/);
  }, 60_000);

  it('a missing API key exits 2 through the shared reporter, not a hand-rolled line', () => {
    const r = run('run.ts', ['--smoke'], { ANTHROPIC_API_KEY: '' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('eval gate COULD NOT RUN');
    expect(r.stderr).toMatch(/ANTHROPIC_API_KEY is unset/);
    // The two-line shape, not one line or three — the format both entrypoints share.
    expect(reportLines(r.stderr)).toHaveLength(2);
  }, 60_000);

  it('the SAME fault through `main.ts evals` gets the same code — the two routes agree', () => {
    // The contract was false for this route for two rounds, because only run.ts had been
    // updated. That is the drift this test exists to catch.
    const r = run('main.ts', ['evals', '--runs', '0'], { ANTHROPIC_API_KEY: 'sk-test' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('COULD NOT RUN');
  }, 60_000);

  it('a non-evals command names ITSELF, and cannot-run means 2 there too', () => {
    // `cli repl` runs no cases and has no CI job to re-run; labelling its failures
    // "eval gate ... so no case ever ran" was wrong three ways. Asserting only the ABSENCE
    // of the eval label — which is what this test used to do — was satisfied by "cli COULD
    // NOT RUN" and by the exit code 1 these gates used to produce, so neither the label nor
    // the code was actually pinned.
    const r = run('main.ts', ['repl'], { ANTHROPIC_API_KEY: '', DATABASE_URL: '' });
    expect(r.stderr).not.toContain('eval gate COULD NOT RUN');
    expect(r.stderr).toContain('repl COULD NOT RUN');
    // 2, not 1: the environment cannot support the run. These gates printed and set 1.
    expect(r.code).toBe(2);
      expect(reportLines(r.stderr)).toHaveLength(2);
  }, 60_000);

  it('a bad repl flag is reported as repl, through main.ts s shared catch', () => {
    // The other route to the label: this one goes through failureLabel() rather than
    // through runRepl's own reportAndExit call, and the two used to disagree — a bad flag
    // said "cli" while a missing DATABASE_URL said "repl", for the same command.
    const r = run('main.ts', ['repl', '--modle', 'opus'], { ANTHROPIC_API_KEY: 'sk-test', DATABASE_URL: 'postgres://x' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('repl COULD NOT RUN');
    expect(r.stderr).toMatch(/unknown argument: --modle/);
  }, 60_000);

  it('printing survives the exit — the message is not lost to an unflushed pipe', () => {
    // stderr to a PIPE is asynchronous on POSIX, and `process.exit()` does not drain it.
    // stdio: 'pipe' above is exactly that shape, so an empty stderr here would be the bug.
    const r = run('run.ts', ['--runs', '0'], { ANTHROPIC_API_KEY: 'sk-test' });
    expect(r.stderr.length).toBeGreaterThan(0);
  }, 60_000);
});
