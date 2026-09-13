/**
 * Did the eval gate FAIL, or could it not RUN?
 *
 * Two different jobs for whoever reads the CI log. "G1 29/30" means look at the code; "the
 * account is out of credit" means top up an account, and no amount of reading the diff will
 * help. On 2026-09-13 `evals-smoke` reported the second as the first: a 40-line
 * `BadRequestError` dump whose actual content was one sentence about a credit balance,
 * indistinguishable at a glance from a real regression. The same conflation the ADR-011
 * supply-chain guard carried between its exit codes, and the same fix.
 *
 * Both stay NON-ZERO. A gate that could not run must be visible — mapping this to a pass,
 * or to a silent skip, is how a suite stops running and nobody notices. The distinction is
 * in the exit code and the message, not in whether CI goes red.
 *
 * The classifier is deliberately narrow, and asymmetrically so: a misclassified gate
 * failure reads as "not my problem" and gets ignored, while a misclassified environment
 * fault merely gets investigated. So a 400 — normally OUR bad request, a malformed tool
 * definition, exactly what this gate exists to catch — is environmental only for the one
 * billing shape, and a 500 is not classified at all.
 */

/** Exit code for "the gate could not run" — 1 stays "the gate ran and failed". */
export const EXIT_CANNOT_RUN = 2;

export interface Unrunnable {
  /** One line, for the top of a CI log. */
  reason: string;
  /** What to do about it. */
  hint: string;
}

/** The Anthropic SDK's thrown shape: an HTTP status plus the parsed error body. */
interface ApiErrorLike {
  status: number;
  error: { error: { type?: unknown; message?: unknown } };
}

function asApiError(err: unknown): ApiErrorLike | null {
  if (typeof err !== 'object' || err === null) return null;
  const { status, error } = err as { status?: unknown; error?: unknown };
  if (typeof status !== 'number') return null;
  if (typeof error !== 'object' || error === null) return null;
  const inner = (error as { error?: unknown }).error;
  if (typeof inner !== 'object' || inner === null) return null;
  return { status, error: { error: inner } };
}

export function classifyUnrunnable(err: unknown): Unrunnable | null {
  const api = asApiError(err);
  if (api === null) return null;
  const message = typeof api.error.error.message === 'string' ? api.error.error.message : '';

  switch (api.status) {
    case 400:
      // ONLY the billing shape. Every other 400 is a request this code built wrong, which
      // is a contract break and belongs to the gate.
      return /credit balance/i.test(message)
        ? {
            reason: 'the Anthropic account has no credit left, so no case ever ran',
            hint: 'top up the key in Plans & Billing, then re-run the job — nothing about this branch is implicated',
          }
        : null;
    case 401:
      return {
        reason: 'the API key was rejected, so no case ever ran',
        hint: 'check the ANTHROPIC_API_KEY secret (rotated? wrong workspace?), then re-run the job',
      };
    case 403:
      return {
        reason: 'the API key is not permitted to use this model or workspace, so no case ever ran',
        hint: 'check the key\'s workspace and model permissions, then re-run the job',
      };
    case 429:
      return {
        reason: 'the API rate- or usage-limited this run',
        hint: 're-run the job; if it recurs, the suite needs pacing rather than a code change',
      };
    case 529:
      return {
        reason: 'the API is overloaded',
        hint: 're-run the job — this says nothing about the branch',
      };
    default:
      // 500s included: an API fault mid-suite is worth investigating, not excusing.
      return null;
  }
}
