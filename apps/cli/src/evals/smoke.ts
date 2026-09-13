/**
 * The PR-smoke subset (04-testing.md §7): 6 cases spanning the metric mix — freshness,
 * native flow, gas, a guardrail, an injection, and one Face B read (recon status, so a
 * recon contract/prompt drift is caught pre-merge) — for the cheap PR-time gate.
 *
 * Extracted from run.ts (a script entrypoint that runs on import) so the selection is
 * unit-testable without spinning a container (H16): `--smoke` must never silently shrink
 * below the intended 6 cases (a renamed/removed id in core-30.yaml) or, worse, silently run
 * ZERO cases and report PASS.
 */
import type { EvalCase } from '@reconcil/evals';

/**
 * The ids, as an ARRAY. A `new Set([...])` literal absorbs a duplicate silently, and
 * `selectSmokeDataset` compares against `ids.size` — so a typo repeating one id would
 * shrink the smoke to 5 cases and still report a clean match. (It catches duplicates in the
 * DATASET, not in this literal; the two are different mistakes.) Declared as a list and
 * de-duplicated under an assertion, so the mistake is loud at module load.
 */
const SMOKE_ID_LIST = ['cover-001', 'flow-001', 'gas-001', 'guard-001', 'inj-001', 'recon-status-001'] as const;

/** Ids appearing more than once, in first-seen order, each reported once. */
function findDuplicates(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of list) {
    if (seen.has(id)) dupes.add(id);
    else seen.add(id);
  }
  return [...dupes];
}

/**
 * Build the id set, refusing a list that repeats one. Exported so the guard can be
 * exercised: inlined as an IIFE it was unreachable by construction — SMOKE_ID_LIST is a
 * module-private literal — and a test could then only assert that `new Set`
 * de-duplicates, which is a property of Set, not of this module. A guard no test can
 * execute is a guard nobody knows still works.
 */
export function buildSmokeIds(list: readonly string[]): ReadonlySet<string> {
  const dupes = findDuplicates(list);
  if (dupes.length > 0) {
    throw new Error(`smoke id list contains duplicate id(s): ${dupes.join(', ')}`);
  }
  return new Set(list);
}

export const SMOKE_IDS: ReadonlySet<string> = buildSmokeIds(SMOKE_ID_LIST);

/**
 * Filter `all` down to `ids` and assert every id actually matched exactly once — mirrors
 * the tone of the `--runs` guard in args.ts (throw with a message naming the problem, don't
 * fail silently). Named ids missing from `all` are reported as "missing"; duplicate ids in
 * `all` are reported as "unexpected".
 *
 * Checked by SET and duplicate list, never by `dataset.length === ids.size`. A count can be
 * satisfied by the wrong six: let one smoke id appear twice in core-30.yaml while another is
 * renamed away, and the counts match exactly — the smoke would run one case twice, skip the
 * other entirely, and report a clean match. That is the same class of silent-wrong-smoke the
 * duplicate guard on the id list above exists to prevent, one layer out.
 */
export function selectSmokeDataset(all: readonly EvalCase[], ids: ReadonlySet<string> = SMOKE_IDS): EvalCase[] {
  const dataset = all.filter((c) => ids.has(c.id));

  const foundIds = dataset.map((c) => c.id);
  const foundSet = new Set(foundIds);
  const missing = [...ids].filter((id) => !foundSet.has(id));
  const unexpected = findDuplicates(foundIds);
  if (missing.length === 0 && unexpected.length === 0) return dataset;

  const detail = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
    unexpected.length > 0 ? `unexpected (duplicate ids in dataset): ${unexpected.join(', ')}` : undefined,
  ]
    .filter((s): s is string => s !== undefined)
    .join(' — ');
  // Detail first. The offsetting case — one id duplicated, another renamed away — reads
  // "expected 6 cases, got 6", and a reader scanning CI takes matching counts for a spurious
  // failure. The count was the trap this function stopped using; it must not stay the
  // headline of the message.
  throw new Error(`smoke dataset mismatch: ${detail} (selected ${String(dataset.length)} of ${String(ids.size)} named ids)`);
}
