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
import { inspect } from 'node:util';

import Anthropic from '@anthropic-ai/sdk';


/** Exit code for "the gate could not run" — 1 stays "the gate ran and failed". */
export const EXIT_CANNOT_RUN = 2;

/**
 * A bad invocation: an unknown flag, `--runs 0`, a `--cases` id that is not in the dataset.
 * Its own class because the exit code has to tell it apart from a gate failure — the suite
 * never started, so reporting 1 ("the gate ran and missed") sends the reader to a diff that
 * cannot explain it. Same reasoning that moved the missing-ANTHROPIC_API_KEY branch to 2.
 */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

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

/** Connection-level SDK errors carry no HTTP status — there was no response to have one. */
function isConnectionFault(err: unknown): boolean {
  // `instanceof`, NOT `err.name`. The SDK sets no `name` on any of its error classes, so
  // `name === 'APIConnectionError'` never matched and this whole branch was dead code —
  // a gateway being down still exited 1 with the raw dump. `APIConnectionTimeoutError`
  // extends `APIConnectionError`, so one check covers both; `APIUserAbortError` does NOT,
  // which is correct — see below.
  return err instanceof Anthropic.APIConnectionError;
}

/** A deliberate cancellation: neither a gate failure nor an environment fault. */
function isUserAbort(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError;
}

export function classifyUnrunnable(err: unknown): Unrunnable | null {
  if (err instanceof UsageError) {
    return { reason: err.message, hint: 'fix the invocation and run again — the gate never started' };
  }
  const status = apiStatus(err);
  if (status === null) {
    if (isUserAbort(err)) {
      // Ctrl-C or an explicit abort signal. Diagnosing it as a network problem — which a
      // single "no status ⇒ connection fault" branch would — hands the operator a remedy
      // for something nobody broke.
      return { reason: 'the run was cancelled before it finished', hint: 'start it again when ready' };
    }
    // No status means no response: the gateway is down, DNS flaked, or the request timed
    // out. run.ts already calls "a dropped connection" a failure "not about the cases at
    // all"; keying purely on status contradicted that and sent it to exit 1, where the
    // documented rule tells the reader the branch under review broke the gate.
    return isConnectionFault(err)
      ? {
          reason: 'the API could not be reached, so the run did not complete',
          hint: 'retry; if it recurs, check ANTHROPIC_BASE_URL and network egress — the code under test is not implicated',
        }
      : null;
  }
  const message = apiMessage(err);

  switch (status) {
    case 502:
    case 503:
    case 504:
      // A gateway's own failure, not the API's. Same class as no response at all.
      return {
        reason: `the API gateway returned ${String(status)}, so the suite did not complete`,
        hint: 're-run the job; if it recurs, check the ANTHROPIC_BASE_URL gateway — the branch is not implicated',
      };
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

/**
 * The two-line shape an unrunnable run reports: what happened, then what to do.
 *
 * The LABEL is a parameter because `main.ts` routes every command through the same catch.
 * Reporting a `repl` failure as "eval gate COULD NOT RUN … so no case ever ran" was wrong
 * three ways: no eval case existed in that run, there is no CI job to re-run, and
 * 04-testing.md defines exit 2 as the eval runner's contract specifically. The classified
 * REASON ("the API key was rejected") is shared; the framing around it is not.
 */
export function unrunnableLines(u: Unrunnable, label = 'eval gate'): string[] {
  return [`${label} COULD NOT RUN: ${u.reason}`, `  → ${u.hint}`];
}

/**
 * Classify, report and exit — the whole failure path, so both entrypoints cannot drift
 * apart again (the exit-code contract was false for `cli evals` for two rounds because
 * only one of them had been updated).
 */
export async function reportFailure(label: string, err: unknown): Promise<never> {
  const unrunnable = classifyUnrunnable(err);
  return reportAndExit(
    unrunnable !== null ? EXIT_CANNOT_RUN : 1,
    unrunnable !== null ? unrunnableLines(unrunnable, label) : [`${label} failed: ${inspect(err, { depth: 5 })}`],
  );
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
  // Set FIRST, before anything that can go wrong. The code used to be applied only by the
  // `process.exit` below, which made it conditional on getting there: a synchronous throw
  // from `write` on a destroyed stderr rejects this function, the callers `void` it, and
  // Node exits 1 — silently downgrading a classified EXIT_CANNOT_RUN. Worse, a callback
  // that never fires lets the loop drain and the process exit 0: a gate that could not run
  // reported GREEN, which this module's own header forbids.
  process.exitCode = code;
  try {
    for (const line of lines) {
      await new Promise<void>((resolve) => {
        // `resolve` on both paths: the write callback receives an error rather than
        // throwing, and a failure to print must not change the exit code already set.
        process.stderr.write(`${line}
`, () => { resolve(); });
      });
    }
  } catch {
    // Swallowed deliberately. `process.exitCode = 2` does NOT survive an unhandled
    // rejection — Node exits 1 — so letting a throw escape here silently downgrades a
    // classified "could not run" into "the gate ran and found a regression", which is the
    // one outcome this module exists to prevent. Verified: `node -e "process.exitCode=2;
    // Promise.reject(new Error('x'))"` exits 1. Losing the message is bad; losing the
    // code is worse, because the code is what CI reads.
  }
  process.exit(code);
}
