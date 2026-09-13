/**
 * A bad invocation: an unknown flag, `--runs 0`, a `--cases` id that is not in the dataset.
 *
 * Its own class because the exit code has to tell it apart from a gate failure — the suite
 * never started, so reporting 1 ("the gate ran and missed") sends the reader to a diff that
 * cannot explain it. Same reasoning that put the missing-ANTHROPIC_API_KEY branch on 2.
 *
 * Its own MODULE because it was briefly in runnability.ts, which imports the Anthropic SDK
 * at top level: that pulled the SDK into `main.ts` — a deliberately lazy argv router that
 * dynamic-imports its commands so `reconcil` with no arguments does nothing but print
 * usage — and into `args.ts`, whose docstring says it was extracted "so it is pure and
 * unit-testable". Three lines of Error subclass should not cost either property.
 */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}
