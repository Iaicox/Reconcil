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

/**
 * Values appearing more than once, each reported once, in first-REPETITION order — the
 * order in which the duplicates were detected, not the order the values first appeared.
 * `['b','a','a','b']` gives `['a','b']`. Both callers print this into an error message, so
 * a reader matching it against their input would otherwise get a misleading account of
 * which id was hit first.
 *
 * Here rather than in smoke.ts because both callers are about reporting a bad invocation,
 * and this module is the one they can both reach without pulling in the Anthropic SDK.
 */
export function findDuplicates(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of list) {
    if (seen.has(id)) dupes.add(id);
    else seen.add(id);
  }
  return [...dupes];
}

/**
 * Join the named defects of an id mismatch into one message, skipping the empty ones.
 *
 * Shared because both callers had grown the same shape — and because an empty result is the
 * failure mode that keeps recurring here: every version of this that reported only SOME of
 * the ways a selection can be wrong eventually produced an error naming nothing. Returning
 * null rather than '' makes the caller decide what to do about that, instead of throwing a
 * blank message.
 */
export function describeIdMismatch(parts: readonly (readonly [label: string, ids: readonly string[]])[]): string | null {
  const detail = parts
    .filter(([, ids]) => ids.length > 0)
    .map(([label, ids]) => `${label}: ${ids.join(', ')}`)
    .join(' — ');
  return detail === '' ? null : detail;
}
