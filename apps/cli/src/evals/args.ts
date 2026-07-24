/**
 * CLI argument parsing for `evals run` — extracted from run.ts so it is pure and
 * unit-testable (importing run.ts would execute the runner). Two robustness guards for a
 * cost-bearing live-LLM command: `--runs` must be a positive integer (an unvalidated
 * NaN/0 makes runSuite's loop never execute, so every metric aggregates non-applicable and
 * the gate passes vacuously over ZERO runs); and an unknown flag is a hard error, not a
 * silent no-op (a mistyped `--smoek` would otherwise fall through and run the full 30×3).
 */
import { coreDatasetPath } from '@reconcil/evals';

export const DEFAULT_MODEL = 'claude-opus-4-8';

/** Suite name → dataset-path loader. `--suite` selects from here (one entry today; a Face-B
 *  `recon` suite is on the roadmap, 04-testing.md §5). coreDatasetPath is a pure path helper. */
export const DATASETS: Record<string, () => string> = {
  core: coreDatasetPath,
};

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
    // `run` (`evals run …`) and the bare `--` pnpm forwards (`evals -- --smoke`) are no-ops.
    else if (a === 'run' || a === '--') continue;
    else throw new Error(`unknown argument: ${String(a)}`);
  }
  if (args.smoke) args.runs = 1;
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    throw new Error(`--runs must be a positive integer (got: ${String(args.runs)})`);
  }
  if (!Object.hasOwn(DATASETS, args.suite)) {
    throw new Error(`unknown suite: ${args.suite} (known: ${Object.keys(DATASETS).join(', ')})`);
  }
  return args;
}
