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

/**
 * The HTTP status, if this is any kind of API error.
 *
 * Status only — NOT the nested `error.error` body the Anthropic SDK parses. CI can point
 * ANTHROPIC_BASE_URL at a gateway (ci.yml), and this repo has already been bitten by one
 * returning a non-Anthropic body: a 401 that arrived as a 400 saying "Unsupported Claude
 * Code version". Requiring the nested shape meant any such gateway fell through to the
 * raw-dump path this module exists to remove — exactly when the operator most needs to be
 * told the gate could not run. The status is the part every HTTP intermediary preserves.
 */
function apiStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const { status } = err as { status?: unknown };
  return typeof status === 'number' ? status : null;
}

/**
 * Best-effort message, across the shapes a body can arrive in: the SDK's parsed
 * `error.error.message`, a flatter `error.message`, a bare string `error`, or the Error's
 * own message (the SDK puts the body text there too). Only the 400 branch consults it.
 */
function apiMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const e = err as { error?: unknown; message?: unknown };
  const parts: unknown[] = [];
  if (typeof e.error === 'string') parts.push(e.error);
  else if (typeof e.error === 'object' && e.error !== null) {
    const body = e.error as { message?: unknown; error?: unknown };
    parts.push(body.message);
    if (typeof body.error === 'object' && body.error !== null) {
      parts.push((body.error as { message?: unknown }).message);
    }
  }
  parts.push(e.message);
  return parts.filter((x): x is string => typeof x === 'string').join(' ');
}

export function classifyUnrunnable(err: unknown): Unrunnable | null {
  const status = apiStatus(err);
  if (status === null) return null;
  const message = apiMessage(err);

  switch (status) {
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

/** The two-line shape an unrunnable gate reports: what happened, then what to do. */
export function unrunnableLines(u: Unrunnable): string[] {
  return [`eval gate COULD NOT RUN: ${u.reason}`, `  → ${u.hint}`];
}

/**
 * Write to stderr, WAIT for it to flush, then exit.
 *
 * Both halves are load-bearing and they pull against each other. `console.error` followed
 * by `process.exit()` can print nothing at all: on POSIX, stderr to a pipe — a CI log — is
 * asynchronous, and `process.exit()` calls reallyExit without draining libuv's write queue,
 * so the job goes red with a bare code and no explanation. But merely setting
 * `process.exitCode` and returning leaves termination to the event loop, and the Anthropic
 * client's keep-alive sockets are live handles: the process then waits out a keep-alive
 * timeout at best, and at worst hangs until the job timeout and reports as a timeout rather
 * than as the classified fault this exists to surface.
 *
 * Writing with a callback resolves when the chunk has actually been handed to the OS, so
 * exiting immediately afterwards is safe and prompt.
 */
export async function reportAndExit(code: number, lines: readonly string[]): Promise<never> {
  for (const line of lines) {
    await new Promise<void>((resolve) => {
      process.stderr.write(`${line}
`, () => { resolve(); });
    });
  }
  process.exit(code);
}
