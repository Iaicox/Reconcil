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

export const SMOKE_IDS: ReadonlySet<string> = (() => {
  const set = new Set<string>(SMOKE_ID_LIST);
  if (set.size !== SMOKE_ID_LIST.length) {
    const seen = new Set<string>();
    const dupes = SMOKE_ID_LIST.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    throw new Error(`SMOKE_ID_LIST contains duplicate id(s): ${[...new Set(dupes)].join(', ')}`);
  }
  return set;
})();

/**
 * Filter `all` down to `ids` and assert every id actually matched exactly once — mirrors
 * the tone of the `--runs` guard in args.ts (throw with a message naming the problem, don't
 * fail silently). Named ids missing from `all` are reported as "missing"; if the filtered
 * result is still longer than `ids.size` with nothing missing, `all` must carry duplicate
 * ids, reported as "unexpected".
 */
export function selectSmokeDataset(all: readonly EvalCase[], ids: ReadonlySet<string> = SMOKE_IDS): EvalCase[] {
  const dataset = all.filter((c) => ids.has(c.id));
  if (dataset.length === ids.size) return dataset;

  const foundIds = dataset.map((c) => c.id);
  const foundSet = new Set(foundIds);
  const missing = [...ids].filter((id) => !foundSet.has(id));
  const seen = new Set<string>();
  const unexpected = foundIds.filter((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });

  const detail = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
    unexpected.length > 0 ? `unexpected (duplicate ids in dataset): ${unexpected.join(', ')}` : undefined,
  ]
    .filter((s): s is string => s !== undefined)
    .join(' — ');
  throw new Error(`smoke dataset mismatch: expected ${String(ids.size)} cases, got ${String(dataset.length)} (${detail})`);
}
