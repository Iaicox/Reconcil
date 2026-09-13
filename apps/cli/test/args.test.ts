/**
 * `parseArgs` — which had no tests at all, in a module whose own docstring says it was
 * "extracted from run.ts so it is pure and unit-testable". Both of its stated robustness
 * guards protect a cost-bearing live-LLM command, and neither was covered.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_MODEL, parseArgs } from '../src/evals/args.js';
import { UsageError } from '../src/evals/usage-error.js';

describe('parseArgs', () => {
  it('defaults to the whole core suite at 3 runs', () => {
    expect(parseArgs([])).toEqual({
      suite: 'core', runs: 3, smoke: false, cases: [], model: DEFAULT_MODEL, out: 'eval-reports',
    });
  });

  it('rejects an unknown flag rather than running the full suite through a typo', () => {
    // The docstring's own example: `--smoek` must not fall through to 30 x 3.
    expect(() => parseArgs(['--smoek'])).toThrow(UsageError);
    expect(() => parseArgs(['--smoek'])).toThrow(/unknown argument/);
  });

  it('rejects a --runs value that would make the gate pass vacuously', () => {
    // runSuite's loop never executes at 0, so every metric aggregates non-applicable and
    // the gate passes over ZERO runs. NaN does the same.
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      expect(() => parseArgs(['--runs', bad]), bad).toThrow(/positive integer/);
    }
    expect(parseArgs(['--runs', '1']).runs).toBe(1);
  });

  it('rejects an unknown suite', () => {
    expect(() => parseArgs(['--suite', 'recon'])).toThrow(/unknown suite/);
    expect(parseArgs(['--suite', 'core']).suite).toBe('core');
  });

  it('rejects --cases with no usable value instead of silently running the whole suite', () => {
    // The expensive failure: an empty `cases` means "no filter", so `--cases` with the value
    // forgotten ran 30 x 3 of live traffic instead of the handful being investigated — the
    // same outcome the unknown-flag guard prevents, reached through the narrowing option.
    // Two distinct causes, two distinct messages: no token at all vs a token with no ids in
    // it. Pinned separately so a change to one cannot quietly start covering the other.
    expect(() => parseArgs(['--cases'])).toThrow(/--cases needs a value/);
    expect(() => parseArgs(['--cases', ''])).toThrow(/at least one case id/);
    expect(() => parseArgs(['--cases', ' , , '])).toThrow(/at least one case id/);
  });

  it('refuses a value flag that swallowed the NEXT flag', () => {
    // `--out --smoke` consumed `--smoke` as the value of `--out`: smoke stayed off, runs
    // stayed 3, and the run became the full 30 x 3 while writing reports into a directory
    // named "--smoke". Every value flag, not just --cases, which was the one that got the
    // guard first.
    for (const flag of ['--out', '--model', '--suite', '--runs', '--cases']) {
      expect(() => parseArgs([flag, '--smoke']), flag).toThrow(/needs a value/);
      expect(() => parseArgs([flag]), flag).toThrow(/needs a value/);
    }
  });

  it('accepts a real --cases list, trimmed', () => {
    expect(parseArgs(['--cases', ' flow-001 , gas-001 ']).cases).toEqual(['flow-001', 'gas-001']);
  });

  it('every bad invocation is a UsageError, so the exit code can tell it from a gate failure', () => {
    for (const argv of [['--smoek'], ['--runs', '0'], ['--suite', 'nope'], ['--cases']]) {
      expect(() => parseArgs(argv), JSON.stringify(argv)).toThrow(UsageError);
    }
  });
});
