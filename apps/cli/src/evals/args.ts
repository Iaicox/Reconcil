/**
 * CLI argument parsing for `evals run` — extracted from run.ts so it is pure and
 * unit-testable (importing run.ts would execute the runner). Two robustness guards for a
 * cost-bearing live-LLM command: `--runs` must be a positive integer (an unvalidated
 * NaN/0 makes runSuite's loop never execute, so every metric aggregates non-applicable and
 * the gate passes vacuously over ZERO runs); and an unknown flag is a hard error, not a
 * silent no-op (a mistyped `--smoek` would otherwise fall through and run the full 30×3).
 */
import { UsageError } from './usage-error.js';
import { coreDatasetPath } from '@reconcil/evals';

import { DEFAULT_MODEL } from '../model.js';

export { DEFAULT_MODEL };

/** Suite name → dataset-path loader. `--suite` selects from here (one entry today; a Face-B
 *  `recon` suite is on the roadmap, 04-testing.md §5). coreDatasetPath is a pure path helper. */
export const DATASETS: Record<string, () => string> = {
  core: coreDatasetPath,
};

export interface Args {
  suite: string;
  runs: number;
  smoke: boolean;
  /** Explicit case ids; empty = the whole suite. Selection only — nothing the model sees. */
  cases: string[];
  model: string;
  out: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { suite: 'core', runs: 3, smoke: false, cases: [], model: DEFAULT_MODEL, out: 'eval-reports' };
  // Kept as the raw token, not parsed on sight: whether --runs was PASSED is a different
  // question from what it parsed to, and the two guards below need both answers.
  let runsRaw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    /**
     * Take the next token as this flag's value, refusing a missing one or another flag.
     *
     * `--out --smoke` used to consume `--smoke` as the value of `--out`: smoke stayed off,
     * runs stayed 3, and the command ran the full 30 x 3 of live traffic while writing
     * reports into a directory named "--smoke". `--runs` with the value forgotten fell back
     * to the 3-run default just as silently. That is the same expensive outcome the
     * unknown-flag guard exists to prevent, reached through the flags beside it.
     */
    const value = (flag: string): string => {
      const v = argv[++i];
      // Empty too, not just missing or --prefixed. `--runs ''` parsed as 0 and reported
      // "--runs must be a positive integer (got: )" — a message whose whole subject is the
      // value it then fails to show. No flag here has a meaningful empty value (`--cases`
      // already rejected blank on its own, one branch below), so the answer belongs in the
      // one helper they all route through.
      if (v === undefined || v === '' || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (a === '--smoke') args.smoke = true;
    else if (a === '--cases') {
      // A missing or blank value used to leave `cases` empty, which means "no filter" —
      // so `--cases` with the value forgotten ran the full 30x3 of live traffic instead of
      // the handful the operator meant to investigate. That is the same outcome this
      // parser's unknown-flag guard exists to prevent, reached through the option whose
      // whole purpose is to narrow the run.
      const ids = value('--cases').split(',').map((c) => c.trim()).filter(Boolean);
      if (ids.length === 0) throw new UsageError('--cases needs at least one case id');
      args.cases = ids;
    }
    else if (a === '--suite') args.suite = value('--suite');
    else if (a === '--runs') runsRaw = value('--runs');
    else if (a === '--model') args.model = value('--model');
    else if (a === '--out') args.out = value('--out');
    // `run` (`evals run …`) and the bare `--` pnpm forwards (`evals -- --smoke`) are no-ops.
    else if (a === 'run' || a === '--') continue;
    else throw new UsageError(`unknown argument: ${String(a)}`);
  }
  // Order matters, and it used to be the other way round. `if (args.smoke) args.runs = 1`
  // ran FIRST, which overwrote the flag's value before anything looked at it: `--smoke
  // --runs abc` replaced NaN with 1 and never said a word, so the guard that exists to stop
  // a vacuous zero-run gate was disabled by the flag standing next to it. And `--smoke
  // --runs 5` silently ran once — a value the operator typed, discarded without a warning.
  //
  // So: 1 is the smoke DEFAULT, not an override. An explicit --runs wins (six cases three
  // times is a legitimate way to chase a flaky one) and is validated whether or not --smoke
  // is present.
  if (runsRaw !== undefined) args.runs = Number(runsRaw);
  else if (args.smoke) args.runs = 1;
  // On the FINAL value, not gated on whether --runs was passed. Today that is belt and
  // braces rather than a closed hole, and the comment here used to claim otherwise: with no
  // --runs token `args.runs` can only hold the literals 3 or 1, both of which pass, so the
  // check cannot fire on that path and the `String(args.runs)` fallback below is
  // unreachable. It is kept where it is because the invariant this module's docstring
  // states — no vacuous zero-run gate — is a property of the value, and pinning it to the
  // token means a future default, or a future writer of `args.runs`, escapes it silently.
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    // The raw token, which `value()` guarantees is non-empty: `String(args.runs)` printed
    // "got: NaN", describing the parse rather than the input the operator has to correct.
    throw new UsageError(`--runs must be a positive integer (got: ${runsRaw ?? String(args.runs)})`);
  }
  if (!Object.hasOwn(DATASETS, args.suite)) {
    throw new UsageError(`unknown suite: ${args.suite} (known: ${Object.keys(DATASETS).join(', ')})`);
  }
  return args;
}
