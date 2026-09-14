/**
 * Telling "the gate could not run" apart from "the gate found a regression".
 *
 * On 2026-09-13 `evals-smoke` went red with a 40-line `BadRequestError` dump whose actual
 * content was "Your credit balance is too low". Nothing in the CI summary distinguished
 * that from a real eval failure — the same conflation the ADR-011 supply-chain guard had
 * between its exit codes, and the same fix: an environmental fault is a different job for
 * whoever reads the log than a failing metric.
 *
 * The classifier is deliberately NARROW. A 400 is normally OUR bug — a malformed tool
 * definition, a bad request shape — and must stay a gate failure; only the specific
 * billing shape is environmental. Misclassifying in that direction would turn a real
 * contract break into "not my problem".
 */
import { describe, expect, it } from 'vitest';

import { DatasetError, UsageError, classifyUnrunnable } from '../src/evals/runnability.js';

/** The shape the Anthropic SDK throws: a status plus the parsed error body. Other shapes —
 *  what a gateway might return — are covered separately below. */
function apiError(status: number, type: string, message: string): unknown {
  return Object.assign(new Error(`${String(status)} ${message}`), {
    status,
    error: { type: 'error', error: { type, message } },
  });
}

describe('classifyUnrunnable', () => {
  it('recognises an exhausted credit balance', () => {
    const err = apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');
    expect(classifyUnrunnable(err)?.reason).toMatch(/credit/i);
  });

  it('recognises a rejected key', () => {
    expect(classifyUnrunnable(apiError(401, 'authentication_error', 'invalid x-api-key'))?.reason).toMatch(/key/i);
  });

  it('recognises a permission failure', () => {
    expect(classifyUnrunnable(apiError(403, 'permission_error', 'not allowed'))).not.toBeNull();
  });

  it('recognises rate limiting and an overloaded API', () => {
    expect(classifyUnrunnable(apiError(429, 'rate_limit_error', 'slow down'))).not.toBeNull();
    expect(classifyUnrunnable(apiError(529, 'overloaded_error', 'overloaded'))).not.toBeNull();
  });

  it('does NOT swallow a 400 that is our own bad request — that is a gate failure', () => {
    // A malformed tool definition is exactly the contract break this gate exists to catch.
    expect(classifyUnrunnable(apiError(400, 'invalid_request_error', 'tools.0.input_schema: invalid schema'))).toBeNull();
  });

  it('does NOT classify a 500 — an API fault mid-suite is worth investigating, not excusing', () => {
    expect(classifyUnrunnable(apiError(500, 'api_error', 'internal'))).toBeNull();
  });

  it('returns null for a plain error that carries no HTTP status and is not an SDK fault', () => {
    expect(classifyUnrunnable(new Error('assertion failed'))).toBeNull();
    expect(classifyUnrunnable('a string')).toBeNull();
    expect(classifyUnrunnable(null)).toBeNull();
    expect(classifyUnrunnable({ error: { error: { message: 'no status here' } } })).toBeNull();
  });
  it('classifies a REAL SDK connection error — the shape, not a hand-built stand-in', async () => {
    // This is the test that was missing, and its absence is why the first version of this
    // branch shipped dead code: it keyed on `err.name`, which the SDK never sets (every one
    // of its error classes inherits name === 'Error'). A hand-built `{ name:
    // 'APIConnectionError' }` would have passed happily while the real thing fell through
    // to exit 1 with the raw dump.
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const conn = new Anthropic.APIConnectionError({ message: 'socket hang up' });
    expect(conn.name).toBe('Error'); // the trap, asserted so it cannot quietly change
    expect(conn.status).toBeUndefined();
    expect(classifyUnrunnable(conn)?.reason).toMatch(/could not be reached/i);
  });

  it('classifies a REAL timeout — it subclasses the connection error, so one check covers both', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const timeout = new Anthropic.APIConnectionTimeoutError({ message: 'timed out' });
    expect(classifyUnrunnable(timeout)?.reason).toMatch(/could not be reached/i);
  });

  it('does not give a deliberate abort a network diagnosis', async () => {
    // APIUserAbortError does NOT subclass APIConnectionError, so it must be handled on its
    // own — otherwise Ctrl-C is reported as "check ANTHROPIC_BASE_URL and network egress".
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const abort = new Anthropic.APIUserAbortError();
    const c = classifyUnrunnable(abort);
    expect(c?.reason).toMatch(/cancelled/i);
    expect(c?.hint).not.toMatch(/network|egress|ANTHROPIC_BASE_URL/i);
  });


  it('classifies on STATUS, not on the shape of the body a gateway returned', () => {
    // CI may point ANTHROPIC_BASE_URL at a gateway, and this repo has already met one that
    // returned a non-Anthropic body. Requiring the SDK's nested error.error shape sent every
    // such response down the raw-dump path — precisely when the operator most needs telling
    // that the gate could not run.
    expect(classifyUnrunnable({ status: 401 })).not.toBeNull();
    expect(classifyUnrunnable({ status: 429, error: 'rate limited' })).not.toBeNull();
    expect(classifyUnrunnable({ status: 403, error: { message: 'flat body' } })).not.toBeNull();
  });

  it('finds the billing signature wherever in the body it arrives', () => {
    // The 400 branch is the only one that reads the message, so it is the only one a
    // reshaped body can silently defeat.
    for (const shaped of [
      { status: 400, error: { error: { message: 'Your credit balance is too low' } } },
      { status: 400, error: { message: 'Your credit balance is too low' } },
      { status: 400, error: 'Your credit balance is too low' },
      Object.assign(new Error('400 Your credit balance is too low'), { status: 400 }),
    ]) {
      expect(classifyUnrunnable(shaped), JSON.stringify(shaped)).not.toBeNull();
    }
  });

  it('carries a hint that says what to DO, not just what happened', () => {
    const c = classifyUnrunnable(apiError(400, 'invalid_request_error', 'Your credit balance is too low'));
    expect(c?.hint).toMatch(/billing|credit/i);
  });
});

describe('DatasetError', () => {
  it('is cannot-run, and points at the dataset rather than at the invocation', () => {
    // The whole reason the class exists, and nothing executed it: with this branch deleted
    // a DatasetError falls through every other test in this file to `null`, which
    // reportFailure turns into exit 1 — "the gate ran and found a regression" — for a suite
    // that never started. Mutation-checked: `if (false && err instanceof DatasetError)`
    // left all 85 unit tests and all 6 exit-contract tests green.
    const c = classifyUnrunnable(new DatasetError('duplicate id(s) in the dataset: bal-001'));
    expect(c).not.toBeNull();
    expect(c?.reason).toContain('duplicate id(s) in the dataset');
    expect(c?.hint).toMatch(/dataset/);
  });

  it('sends the reader somewhere different from a UsageError', () => {
    // Both exit 2, so the CODE cannot tell them apart — the hint is the only thing that
    // says whether to open the diff or re-read the command line. If these ever converge,
    // splitting the classes bought nothing.
    const dataset = classifyUnrunnable(new DatasetError('x'))?.hint;
    const usage = classifyUnrunnable(new UsageError('x'))?.hint;
    expect(dataset).toBeDefined();
    expect(dataset).not.toBe(usage);
    expect(usage).toMatch(/invocation/);
    expect(dataset).not.toMatch(/invocation/);
  });

  it('does not swallow an ordinary Error carrying the same text', () => {
    expect(classifyUnrunnable(new Error('duplicate id(s) in the dataset: bal-001'))).toBeNull();
  });
});

describe('UsageError', () => {
  it('is classified as cannot-run, with a remedy that names no command', () => {
    const c = classifyUnrunnable(new UsageError('--runs must be a positive integer (got: 0)'));
    expect(c?.reason).toMatch(/--runs must be a positive integer/);
    // Neutral on purpose: main.ts routes repl through this same classifier, so a hint
    // saying "the gate never started" described a gate the command does not have.
    expect(c?.hint).toMatch(/fix the invocation/);
    expect(c?.hint).not.toMatch(/gate|job|suite/);
  });

  it('holds EVERY classified hint to the no-command rule, not just the ones with a status', async () => {
    // Two earlier versions of this test were leaky in the same direction. The first checked
    // three words on ONE hint, so "secret", "branch" and "under test" survived the round
    // that was meant to remove them. The second built its inputs only from `apiError(...)`,
    // which cannot express the two branches that classify with NO http status — and one of
    // those is the connection-fault hint, whose "the code under test" was one of the five
    // phrases that round claimed to have fixed. Reverting it was undetected.
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const classified: unknown[] = [
      new UsageError('bad flag'),
      new DatasetError('duplicate id'),
      new Anthropic.APIConnectionError({ message: 'socket hang up' }),
      new Anthropic.APIUserAbortError(),
      apiError(400, 'invalid_request_error', 'Your credit balance is too low'),
      apiError(401, 'authentication_error', 'invalid x-api-key'),
      apiError(403, 'permission_error', 'not allowed'),
      apiError(429, 'rate_limit_error', 'slow down'),
      apiError(502, 'api_error', 'bad gateway'),
      apiError(529, 'overloaded_error', 'overloaded'),
    ];
    // Every non-null branch of classifyUnrunnable is represented above. Asserted as a COUNT
    // so that adding a branch without adding an input here fails, rather than quietly
    // leaving the new hint unchecked — which is the exact hole this test has had twice.
    expect(classified).toHaveLength(10);

    for (const err of classified) {
      const c = classifyUnrunnable(err);
      expect(c, String(err)).not.toBeNull();
      // `job`/`gate`/`suite`/`branch` name a CI shape repl does not have; `secret` names
      // where CI keeps the key, not where an operator does; `under test` names a test run.
      //
      // Matched as WORDS, not substrings: the 502 reason legitimately says "gateway", which
      // contains "gate". Inflections are enumerated rather than stemmed — "secrets" is the
      // word GitHub itself uses, and an exact-word check let every plural through.
      const text = `${c!.reason} ${c!.hint}`.toLowerCase();
      const words = new Set(text.split(/[^a-z]+/));
      const banned = [
        'gate', 'gates', 'gated', 'gating',
        'job', 'jobs',
        'suite', 'suites',
        'branch', 'branches',
        'secret', 'secrets',
      ];
      for (const word of banned) {
        expect(words.has(word), `${String(err)} :: ${word}`).toBe(false);
      }
      // Non-letters collapsed to single spaces first, so "under-test" is caught too.
      expect(` ${[...text.split(/[^a-z]+/)].join(' ')} `, String(err)).not.toContain(' under test ');
    }
  });

  it('does not swallow an ordinary Error with the same message', () => {
    // The class is the signal, not the text: a genuine failure that happens to mention
    // arguments must still read as a gate failure.
    expect(classifyUnrunnable(new Error('--runs must be a positive integer'))).toBeNull();
  });
});
