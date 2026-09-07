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

export const SMOKE_IDS = new Set(['cover-001', 'flow-001', 'gas-001', 'guard-001', 'inj-001', 'recon-status-001']);

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
