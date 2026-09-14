/**
 * The PR-smoke subset (04-testing.md §7): 6 cases spanning the metric mix — freshness,
 * native flow, gas, a guardrail, an injection, and one Face B read (recon status, so a
 * recon contract/prompt drift is caught pre-merge) — for the cheap PR-time gate.
 *
 * Both selections — `--smoke` and `--cases` — live here rather than in run.ts, which is a
 * script entrypoint that provisions a container and spends live API budget before anything
 * in it can be observed. Selection is the part that must never be silently wrong (H16):
 * `--smoke` must not shrink below the intended 6 cases through a renamed id in
 * core-30.yaml, or — worse — run ZERO cases and report PASS. A guard that only exists on a
 * path no test can reach is a guard nobody knows still works, which is how the duplicate
 * check below was born inert on the full-suite path and stayed that way until something
 * could execute it.
 */
import type { EvalCase } from '@reconcil/evals';

import { DatasetError, UsageError, describeIdMismatch, findDuplicates } from './usage-error.js';

/**
 * The ids, as an ARRAY. A `new Set([...])` literal absorbs a duplicate silently, so a typo
 * repeating one id would shrink the smoke to 5 cases without a word — and the checks
 * downstream would not notice, because they are about duplicates in the DATASET, which is a
 * different mistake. Declared as a list and de-duplicated under an assertion instead.
 *
 * Two clauses that used to live here are gone rather than reworded: the assertion is no
 * longer "loud at module load" (`smokeIds()` exists precisely so it is loud at CALL time —
 * see below), and `selectSmokeDataset` no longer "compares against `ids.size`" — it stopped
 * comparing counts several rounds ago, for reasons its own docstring gives.
 */
const SMOKE_ID_LIST = ['cover-001', 'flow-001', 'gas-001', 'guard-001', 'inj-001', 'recon-status-001'] as const;

/**
 * Build the id set, refusing a list that repeats one. Exported so the guard can be
 * exercised: inlined as an IIFE it was unreachable by construction — SMOKE_ID_LIST is a
 * module-private literal — and a test could then only assert that `new Set`
 * de-duplicates, which is a property of Set, not of this module. A guard no test can
 * execute is a guard nobody knows still works.
 */
export function buildSmokeIds(list: readonly string[]): ReadonlySet<string> {
  // Empty is the module header's other stated nightmare — "silently run ZERO cases and
  // report PASS" — and the duplicate guard inherited the hole from the length check it
  // replaced: an empty set makes `missing` and `unexpected` both empty, so
  // selectSmokeDataset returns [] and the gate passes over nothing.
  // DatasetError, not Error and not UsageError. A plain Error maps to exit 1, which the
  // contract reads as "the gate ran and found a regression" — it never ran. A UsageError
  // would exit 2 with "fix the invocation", but a renamed case id or a repeated smoke id is
  // in the DIFF, not in the command line. Both were wrong in different directions.
  if (list.length === 0) throw new DatasetError('smoke id list is empty — that would run zero cases and report a pass');
  const dupes = findDuplicates(list);
  if (dupes.length > 0) {
    throw new DatasetError(`smoke id list contains duplicate id(s): ${dupes.join(', ')}`);
  }
  return new Set(list);
}

/**
 * The smoke id set, built on CALL — deliberately not `export const SMOKE_IDS =
 * buildSmokeIds(SMOKE_ID_LIST)`.
 *
 * As a const, a throw from the guard ran during MODULE EVALUATION, and run.ts imports this
 * file statically. On the path CI actually takes (`tsx src/run.ts --smoke`, the `evals`
 * package script) that is before `runEvals()` is called and before its `.catch()` exists:
 * Node prints an uncaught module-evaluation stack and exits 1 — "the gate ran and found a
 * regression" — for the guard whose entire job is to say the gate could not run. Reached
 * from inside runEvals, the same DatasetError goes through reportFailure and exits 2.
 *
 * Not memoised: it is called once per process, over six strings.
 */
export function smokeIds(): ReadonlySet<string> {
  return buildSmokeIds(SMOKE_ID_LIST);
}

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
export function selectSmokeDataset(all: readonly EvalCase[], ids: ReadonlySet<string> = smokeIds()): EvalCase[] {
  // Guarded HERE too, not only in buildSmokeIds. `ids` is a caller-supplied parameter, and
  // this is the function that actually returns the dataset the gate runs over: an empty set
  // makes `missing` and `unexpected` both empty, so the early return below hands back [],
  // runSuite loops zero times, every metric aggregates non-applicable and the gate reports
  // PASS over ZERO cases. Fixing that one layer up left the function that has the hole.
  if (ids.size === 0) throw new DatasetError('smoke id set is empty — that would run zero cases and report a pass');
  const dataset = all.filter((c) => ids.has(c.id));

  const foundIds = dataset.map((c) => c.id);
  const foundSet = new Set(foundIds);
  const missing = [...ids].filter((id) => !foundSet.has(id));
  const unexpected = findDuplicates(foundIds);
  if (missing.length === 0 && unexpected.length === 0) return dataset;

  const detail = describeIdMismatch([
    ['missing', missing],
    ['unexpected (duplicate ids in dataset)', unexpected],
  ]) ?? 'the selection did not match the named ids';
  // Detail first. The offsetting case — one id duplicated, another renamed away — reads
  // "expected 6 cases, got 6", and a reader scanning CI takes matching counts for a spurious
  // failure. The count was the trap this function stopped using; it must not stay the
  // headline of the message.
  throw new DatasetError(`smoke dataset mismatch: ${detail} (selected ${String(dataset.length)} of ${String(ids.size)} named ids)`);
}

/**
 * Narrow `all` to the ids `--cases` named, or hand back the whole suite when it named none.
 *
 * Three distinct defects, and they do NOT share an exit code. An id that is not in the
 * dataset and an id repeated in the argument are both about the command line — UsageError,
 * "fix the invocation". A duplicate id in the DATASET is in the diff — DatasetError. Both
 * exit 2 ("could not run"), but they send the reader to different places.
 *
 * The dataset check runs on BOTH paths. It used to sit behind `args.cases.length > 0`
 * alongside the other two, which left it inert on exactly the run that can see the defect:
 * the bare `evals` invocation reads the whole dataset, and a duplicate there means the
 * 30x3 grades one case twice, pays for it twice, and files its result under the id that was
 * overwritten. The loader does not enforce uniqueness; core-30.test.ts does, and it does not
 * run here.
 */
export function selectNamedCases(all: readonly EvalCase[], caseIds: readonly string[]): EvalCase[] {
  const selected = caseIds.length > 0 ? all.filter((c) => caseIds.includes(c.id)) : [...all];

  // The ARGUMENT first, the DATASET second — the other order loses a defect. `--cases
  // a,nope` against a dataset holding two `a`s reported only the duplicate and swallowed
  // "unknown case id(s): nope", switching the remedy from "fix the invocation" to "fix the
  // branch" for a run whose invocation was ALSO wrong. This way round nothing is lost: when
  // `--cases` names something the dataset does not have, the selection it produced is not a
  // set worth auditing anyway, and on the full-suite path — where these two checks are inert
  // and the whole dataset is what gets selected — the duplicate check below always runs.
  //
  // Set membership and duplicates, never lengths: `--cases a,b` against a dataset with no
  // `a` and two `b`s gives selected.length === 2 === caseIds.length, so a length check
  // passes while the run executes `b` twice and never runs `a`.
  const selectedIds = new Set(selected.map((c) => c.id));
  const missing = caseIds.filter((id) => !selectedIds.has(id));
  const repeated = findDuplicates(caseIds);
  if (missing.length > 0 || repeated.length > 0) {
    const detail = describeIdMismatch([
      ['unknown case id(s)', missing],
      ['repeated case id(s)', repeated],
    ]);
    // `?? ` is not dead: the guard fires only when one of the two is non-empty, but stating
    // the fallback keeps a future third condition from producing a blank message — the
    // defect this block has now been rewritten for twice.
    throw new UsageError(detail ?? '--cases did not select the requested set');
  }

  const datasetDupes = findDuplicates(selected.map((c) => c.id));
  if (datasetDupes.length > 0) {
    throw new DatasetError(`duplicate id(s) in the dataset: ${datasetDupes.join(', ')}`);
  }

  // The empty selection, guarded LAST because it is what the two checks above cannot catch:
  // `--cases` matched nothing is already `missing`, but an empty core-30.yaml names no id
  // and repeats none, so it walks past both. `datasetSchema` is a bare `z.array(...)` with
  // no `.min(1)`, so an emptied dataset parses cleanly, and gate.ts reads an empty metric
  // set as "vacuously satisfied" — the suite would report PASS having graded nothing.
  //
  // selectSmokeDataset guards exactly this at two layers, with a paragraph on each
  // explaining why one was not enough; this function took over the full-suite path in the
  // same round and arrived with none.
  if (selected.length === 0) {
    throw new DatasetError('the selected dataset is empty — that would run zero cases and report a pass');
  }
  return selected;
}
