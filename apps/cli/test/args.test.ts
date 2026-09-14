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
    // Three distinct causes, pinned separately so a change to one cannot quietly start
    // covering another: no token at all, an empty token, and a token carrying no ids. The
    // middle one moved when value() started refusing '' for every flag — it used to reach
    // the split-and-filter below and report "at least one case id", which described the
    // token's contents rather than the fact that there was no token worth reading.
    expect(() => parseArgs(['--cases'])).toThrow(/--cases needs a value/);
    expect(() => parseArgs(['--cases', ''])).toThrow(/--cases needs a value/);
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
      // The empty token, on every flag rather than on the two that happened to have a test.
      // `--out ''` wrote reports into the package root, `--model ''` sent '' to the API as a
      // model id, `--suite ''` reported "unknown suite: " — three silent misbehaviours, and
      // reverting the guard failed only the --cases and --runs assertions.
      expect(() => parseArgs([flag, '']), flag).toThrow(/needs a value/);
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

describe('--runs beside --smoke', () => {
  it('defaults to one run under --smoke', () => {
    expect(parseArgs(['--smoke']).runs).toBe(1);
  });

  it('honours an explicit --runs instead of overwriting it', () => {
    // `if (args.smoke) args.runs = 1` ran unconditionally, so a value the operator typed was
    // discarded without a word. Six cases three times is a legitimate way to chase a flaky
    // one; 1 is the smoke DEFAULT, not an override.
    expect(parseArgs(['--smoke', '--runs', '3']).runs).toBe(3);
    expect(parseArgs(['--runs', '3', '--smoke']).runs).toBe(3);
  });

  it('still validates --runs when --smoke is present', () => {
    // The ordering defect that mattered: the override ran FIRST, so `--smoke --runs abc`
    // replaced NaN with 1 and reported nothing. The guard against a vacuous zero-run gate
    // was disabled by the flag standing next to it.
    // One alternative, not `/positive integer|needs a value/`. Every value here reaches the
    // integer guard and only that guard, so the second branch of an alternation could never
    // be the one that matched — it would sit there reading as coverage for a path these
    // inputs cannot take. ('' used to be in this list; it is refused earlier now, by
    // value(), and is asserted separately below rather than hidden inside an alternation.)
    for (const bad of ['abc', '0', '-1', '1.5']) {
      expect(() => parseArgs(['--smoke', '--runs', bad]), bad).toThrow(/positive integer/);
    }
    // '' is refused one step earlier, by value(). It used to reach the integer guard as 0
    // and print "--runs must be a positive integer (got: )" — a message whose entire
    // subject is the value it then fails to show.
    expect(() => parseArgs(['--smoke', '--runs', ''])).toThrow(/--runs needs a value/);
  });

  it('reports the raw token, not what it parsed to', () => {
    // `String(args.runs)` printed "got: NaN", which describes the parse rather than the
    // input the operator has to correct.
    expect(() => parseArgs(['--runs', 'abc'])).toThrow(/got: abc/);
  });
});
