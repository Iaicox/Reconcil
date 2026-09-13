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

import { classifyUnrunnable } from '../src/evals/runnability.js';

/** The shape the Anthropic SDK throws: a status plus the parsed error body. */
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

  it('returns null for anything that is not an API error at all', () => {
    expect(classifyUnrunnable(new Error('assertion failed'))).toBeNull();
    expect(classifyUnrunnable('a string')).toBeNull();
    expect(classifyUnrunnable(null)).toBeNull();
    expect(classifyUnrunnable({ status: 401 })).toBeNull(); // no error body — not the SDK shape
  });

  it('carries a hint that says what to DO, not just what happened', () => {
    const c = classifyUnrunnable(apiError(400, 'invalid_request_error', 'Your credit balance is too low'));
    expect(c?.hint).toMatch(/billing|credit/i);
  });
});
