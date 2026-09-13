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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Run { code: number; stderr: string; stdout: string }

/** Run a CLI entrypoint through tsx and report what the process actually did. */
function run(entry: string, args: string[], env: Record<string, string | undefined> = {}): Run {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(CLI_ROOT, 'src', entry), ...args],
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
    expect(r.stderr.trim().split('\n').filter((l) => l.trim() !== '')).toHaveLength(2);
  }, 60_000);

  it('the SAME fault through `main.ts evals` gets the same code — the two routes agree', () => {
    // The contract was false for this route for two rounds, because only run.ts had been
    // updated. That is the drift this test exists to catch.
    const r = run('main.ts', ['evals', '--runs', '0'], { ANTHROPIC_API_KEY: 'sk-test' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('COULD NOT RUN');
  }, 60_000);

  it('a non-evals command does NOT borrow the eval vocabulary', () => {
    // `cli repl` runs no cases and has no CI job to re-run; labelling its failures
    // "eval gate ... so no case ever ran" was wrong three ways.
    const r = run('main.ts', ['repl'], { ANTHROPIC_API_KEY: '' });
    expect(r.stderr).not.toContain('eval gate COULD NOT RUN');
  }, 60_000);

  it('printing survives the exit — the message is not lost to an unflushed pipe', () => {
    // stderr to a PIPE is asynchronous on POSIX, and `process.exit()` does not drain it.
    // stdio: 'pipe' above is exactly that shape, so an empty stderr here would be the bug.
    const r = run('run.ts', ['--runs', '0'], { ANTHROPIC_API_KEY: 'sk-test' });
    expect(r.stderr.length).toBeGreaterThan(0);
  }, 60_000);
});
