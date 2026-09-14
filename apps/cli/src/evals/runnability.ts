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

import { DatasetError, UsageError } from './usage-error.js';


/** Re-exported for callers that already reach for the classifier; the class itself lives in
 *  its own SDK-free module so the argv router and the arg parser stay light. */
export { DatasetError, UsageError };

/** Exit code for "the gate could not run" — 1 stays "the gate ran and failed". */
export const EXIT_CANNOT_RUN = 2;

/** How long to wait for stderr to flush before exiting anyway. Long enough that a healthy
 *  pipe always wins, short enough that a stalled one costs seconds rather than the job. */
const FLUSH_TIMEOUT_MS = 2_000;

/**
 * None of these reasons claims "so no case ever ran". They used to, and it is not knowable
 * here: credit runs out, a key is rotated, or a permission is revoked MID-suite far more
 * often than before it starts — and run.ts writes a partial scorecard in exactly that case,
 * so the two lines contradicted each other in the same CI log, telling the reader to ignore
 * sixty real graded results. The classifier sees the error, not the progress.
 */
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

/**
 * Classify an error as "the run could not start" (exit 2) or not (null ⇒ exit 1).
 *
 * EVERY remedy returned from here names no command, and that took two passes to get right.
 * They said "re-run the job", "the suite did not complete", "the branch is not implicated",
 * "the ANTHROPIC_API_KEY secret", "the code under test" — CI and eval vocabulary, and
 * `repl` reaches every one of them through main.ts's shared catch (a rejected key is the
 * likeliest repl failure there is). The caller's LABEL names the command on the first line;
 * a hint naming a different one is the same defect the label was added to fix, one layer
 * down. `runnability.test.ts` holds every classified hint to that rule.
 *
 * The rule is about THIS function only. A caller that builds its own `Unrunnable` knows
 * which command it is — run.ts's missing-key hint says "re-run the job", repl.ts's says
 * "start the REPL again" — and both are correct precisely because they are not shared.
 */
export function classifyUnrunnable(err: unknown): Unrunnable | null {
  if (err instanceof UsageError) {
    return { reason: err.message, hint: 'fix the invocation and run again — nothing was started' };
  }
  if (err instanceof DatasetError) {
    // Still "could not run" (exit 2 — the suite never started), but the remedy points at
    // the diff, not at the environment or the command line.
    return { reason: err.message, hint: 'the eval dataset or smoke id list is inconsistent — fix the dataset, not the environment' };
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
          hint: 'retry; if it recurs, check ANTHROPIC_BASE_URL and network egress — the code here is not implicated',
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
        reason: `the API gateway returned ${String(status)}, so the run did not complete`,
        hint: 'run it again; if it recurs, check the ANTHROPIC_BASE_URL gateway — the code here is not implicated',
      };
    case 400:
      // ONLY the billing shape. Every other 400 is a request this code built wrong, which
      // is a contract break and belongs to the gate.
      return /credit balance/i.test(message)
        ? {
            reason: 'the Anthropic account has no credit left',
            hint: 'top up the key in Plans & Billing, then run it again — nothing here is implicated',
          }
        : null;
    case 401:
      return {
        reason: 'the API key was rejected',
        hint: 'check ANTHROPIC_API_KEY (rotated? wrong workspace?), then run it again',
      };
    case 403:
      return {
        reason: 'the API key is not permitted to use this model or workspace',
        hint: 'check the key\'s workspace and model permissions, then run it again',
      };
    case 429:
      return {
        reason: 'the API rate- or usage-limited this run',
        hint: 'run it again; if it recurs, it needs pacing rather than a code change',
      };
    case 529:
      return {
        reason: 'the API is overloaded',
        hint: 'run it again — this says nothing about the code here',
      };
    default:
      // 500s included: an API fault mid-suite is worth investigating, not excusing.
      return null;
  }
}

/**
 * The two-line shape an unrunnable run reports: what happened, then what to do.
 *
 * The label is REQUIRED, with no default. A default of 'eval gate' was dead — both call
 * sites pass one — and its only possible effect was to give a future caller who forgot the
 * argument exactly the wrong vocabulary this parameter exists to prevent.
 *
 * The LABEL is a parameter because `main.ts` routes every command through the same catch.
 * Reporting a `repl` failure as "eval gate COULD NOT RUN … so no case ever ran" was wrong
 * three ways: no eval case existed in that run, there is no CI job to re-run, and a reader
 * sent to the eval gate's documentation would find no command of that name. (04-testing.md
 * now states repl's exit codes alongside the runner's — it did not when the label was
 * added, and the fix was to document repl rather than to keep borrowing the gate's name.)
 * The classified REASON ("the API key was rejected") is shared; the framing is not.
 */
export function unrunnableLines(u: Unrunnable, label: string): string[] {
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
    // BOUNDED. `write` calls back when the chunk reaches the OS, which never happens if
    // stderr is a pipe whose reader has stalled or whose buffer is full — a CI runner
    // harvesting logs, a wrapper that stopped draining. Awaiting that without a bound turned
    // "the gate could not run, here is the code" into a job that hangs to its timeout and
    // reports AS a timeout: the one outcome this module exists to prevent, reached through
    // the flush that was added to prevent a different one. The race keeps the flush when
    // stderr is healthy and gives it up when it is not; the exit code is already set either
    // way, and that is the part CI reads.
    await Promise.race([
      (async () => {
        for (const line of lines) {
          await new Promise<void>((resolve) => {
            // `resolve` on both paths: the callback receives an error rather than throwing,
            // and a failure to print must not change the exit code already set.
            process.stderr.write(`${line}
`, () => { resolve(); });
          });
        }
      })(),
      new Promise<void>((resolve) => { setTimeout(resolve, FLUSH_TIMEOUT_MS).unref(); }),
    ]);
  } catch {
    // Swallowed deliberately: losing the message is bad, losing the code is worse.
  }
  process.exit(code);
}
