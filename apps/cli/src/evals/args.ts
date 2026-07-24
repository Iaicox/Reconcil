/**
 * CLI argument parsing for `evals run` — extracted from run.ts so it is pure and
 * unit-testable (importing run.ts would execute the runner). `--runs` is validated to a
 * positive integer: an unvalidated NaN/0 makes runSuite's loop never execute, which
 * aggregates every metric as non-applicable and hands the gate a vacuous pass — the worst
 * failure mode for a safety gate, so it is a hard error.
 */
export const DEFAULT_MODEL = 'claude-opus-4-8';

export interface Args {
  suite: string;
  runs: number;
  smoke: boolean;
  model: string;
  out: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { suite: 'core', runs: 3, smoke: false, model: DEFAULT_MODEL, out: 'eval-reports' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') args.smoke = true;
    else if (a === '--suite') args.suite = argv[++i] ?? args.suite;
    else if (a === '--runs') args.runs = Number(argv[++i] ?? args.runs);
    else if (a === '--model') args.model = argv[++i] ?? args.model;
    else if (a === '--out') args.out = argv[++i] ?? args.out;
    else if (a === 'run') continue; // tolerate `evals run …`
  }
  if (args.smoke) args.runs = 1;
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    throw new Error(`--runs must be a positive integer (got: ${String(args.runs)})`);
  }
  return args;
}
