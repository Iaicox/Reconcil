import type { EvalCase } from '@reconcil/evals';
import { describe, expect, it } from 'vitest';

import { buildSmokeIds, selectNamedCases, selectSmokeDataset, smokeIds } from '../src/evals/smoke.js';
import { DatasetError, UsageError } from '../src/evals/usage-error.js';

/** The real set, resolved once here. `smokeIds()` is a function precisely so that a broken
 *  list throws where a caller can classify it, so the tests hold the value like run.ts does. */
const SMOKE_IDS_T = smokeIds();

function fakeCase(id: string): EvalCase {
  return { id, face: 'A', question: 'q', expect: {} };
}

describe('selectSmokeDataset', () => {
  it('returns exactly the requested subset when every id resolves', () => {
    const all = [fakeCase('a'), fakeCase('b'), fakeCase('c')];
    const dataset = selectSmokeDataset(all, new Set(['a', 'c']));
    expect(dataset.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('throws naming the missing id when a SMOKE_ID has no matching case (H16)', () => {
    // Simulates core-30.yaml drifting a smoke id out from under the runner — the exact
    // failure mode the guard exists to catch loudly instead of silently shrinking the gate.
    const all = [fakeCase('cover-001'), fakeCase('flow-001'), fakeCase('gas-001'), fakeCase('guard-001'), fakeCase('inj-001')];
    expect(() => selectSmokeDataset(all, SMOKE_IDS_T)).toThrow(/missing: recon-status-001/);
  });

  it('a duplicate that exactly offsets a missing id does NOT read as a clean match', () => {
    // The count trap: `dataset.length === ids.size` is satisfied by the WRONG six. Here
    // cover-001 appears twice and recon-status-001 is renamed away, so the filter yields
    // exactly 6 entries — the smoke would run one case twice, never run the Face B case,
    // and report 6/6. Same class as a duplicate in the id list, one layer out.
    const all = [
      fakeCase('cover-001'), fakeCase('cover-001'), fakeCase('flow-001'),
      fakeCase('gas-001'), fakeCase('guard-001'), fakeCase('inj-001'),
    ];
    expect(all.filter((c) => SMOKE_IDS_T.has(c.id))).toHaveLength(SMOKE_IDS_T.size); // the trap
    expect(() => selectSmokeDataset(all, SMOKE_IDS_T)).toThrow(/missing: recon-status-001/);
    expect(() => selectSmokeDataset(all, SMOKE_IDS_T)).toThrow(/duplicate ids in dataset\): cover-001/);
  });

  it('throws naming every missing id when several drift at once', () => {
    const all = [fakeCase('cover-001')];
    expect(() => selectSmokeDataset(all, SMOKE_IDS_T)).toThrow(
      /missing: flow-001, gas-001, guard-001, inj-001, recon-status-001/,
    );
  });

  it('throws over an empty dataset rather than passing vacuously with ZERO cases', () => {
    // Asserted on the DEFECT (which ids are gone), not on the counts: the counts are now a
    // suffix precisely because they are the least informative part of the message.
    expect(() => selectSmokeDataset([], SMOKE_IDS_T)).toThrow(/missing: cover-001, flow-001/);
    expect(() => selectSmokeDataset([], SMOKE_IDS_T)).toThrow(/selected 0 of 6 named ids/);
  });

  it('throws naming duplicates when the source dataset carries a repeated id', () => {
    const all = [fakeCase('a'), fakeCase('a'), fakeCase('b')];
    expect(() => selectSmokeDataset(all, new Set(['a', 'b']))).toThrow(/unexpected \(duplicate ids in dataset\): a/);
  });

  it('defaults to the real smoke id set', () => {
    const all = [...SMOKE_IDS_T].map((id) => fakeCase(id));
    expect(selectSmokeDataset(all)).toHaveLength(SMOKE_IDS_T.size);
  });

  it('builds the ids on call, not at module load — a throw has to reach a classifier', () => {
    // As a module-scope const this threw during module EVALUATION of smoke.ts, which run.ts
    // imports statically: on `tsx src/run.ts --smoke` (what CI runs) that is before
    // runEvals() is called and before its .catch() exists, so Node exited 1 — the code
    // reserved for "the gate ran and failed" — for a guard that means the opposite.
    // The export is a FUNCTION, which is the whole invariant — a `const` binding could only
    // have been produced by calling the guard at module scope. Deliberately NOT asserting a
    // fresh Set per call: a memoised `cached ??= buildSmokeIds(...)` satisfies the real
    // property perfectly (the throw still happens on the first call, inside runEvals, within
    // reach of its catch), and pinning object identity would forbid it for no reason.
    expect(typeof smokeIds).toBe('function');
    expect([...smokeIds()]).toEqual([...SMOKE_IDS_T]);
  });

  it('a duplicate id in the list is loud, not a silently smaller smoke', () => {
    // The failure this guards: `new Set([...])` absorbs a repeat, `ids.size` drops to 5,
    // and selectSmokeDataset's `length === size` check is then satisfied by 5 cases — a
    // smoke one case smaller than intended, reporting a clean match. (selectSmokeDataset's
    // own duplicate check is about duplicates in the DATASET; different mistake.)
    expect(() => buildSmokeIds(['cover-001', 'flow-001', 'cover-001'])).toThrow(
      'duplicate id(s): cover-001',
    );
    // …and it names every repeat, not just the first.
    expect(() => buildSmokeIds(['a', 'a', 'b', 'b'])).toThrow('duplicate id(s): a, b');
    // A clean list passes through unchanged.
    expect(buildSmokeIds(['a', 'b']).size).toBe(2);
    // The real one is built through that guard.
    expect(SMOKE_IDS_T.size).toBe(6);
  });
});

describe('selectNamedCases', () => {
  it('refuses an empty dataset rather than passing over zero cases', () => {
    // Neither check above catches this: an emptied core-30.yaml names no id and repeats
    // none. `datasetSchema` is a bare z.array with no .min(1), so it parses; gate.ts reads
    // an empty metric set as "vacuously satisfied"; the suite reports PASS having graded
    // nothing. selectSmokeDataset guards this twice over; this function arrived with none.
    expect(() => selectNamedCases([], [])).toThrow(DatasetError);
    expect(() => selectNamedCases([], [])).toThrow(/run zero cases and report a pass/);
  });

  it('reports the bad --cases first when the dataset is ALSO broken', () => {
    // Order matters and the first version had it backwards: the dataset check threw first
    // and named only itself, so `--cases a,nope` against a dataset holding two `a`s lost
    // "unknown case id(s): nope" entirely — and switched the remedy from "fix the
    // invocation" to "fix the branch" for a run whose invocation was also wrong.
    const all = [fakeCase('a'), fakeCase('a')];
    expect(() => selectNamedCases(all, ['a', 'nope'])).toThrow(UsageError);
    expect(() => selectNamedCases(all, ['a', 'nope'])).toThrow('unknown case id(s): nope');
  });

  it('hands back the whole suite when --cases named nothing', () => {
    const all = [fakeCase('a'), fakeCase('b')];
    expect(selectNamedCases(all, []).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('narrows to the named ids', () => {
    const all = [fakeCase('a'), fakeCase('b'), fakeCase('c')];
    expect(selectNamedCases(all, ['a', 'c']).map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('catches a duplicate in the DATASET on the full-suite path, not only under --cases', () => {
    // The whole point of moving the check out of run.ts. Gated on `--cases`, it fired for a
    // narrowed run and stayed silent for the bare `evals` one — the 30x3, the only
    // invocation that reads the entire dataset and therefore the only one that can see the
    // duplicate. That run grades the repeated case twice and files the result under the id
    // it shadowed.
    const all = [fakeCase('a'), fakeCase('b'), fakeCase('a')];
    expect(() => selectNamedCases(all, [])).toThrow('duplicate id(s) in the dataset: a');
  });

  it('calls a dataset duplicate a DatasetError and a bad --cases a UsageError', () => {
    // Same exit code (2 — the gate never ran), opposite remedy: one is fixed in the diff,
    // the other at the command line. Reporting either as the other sends the reader to the
    // wrong place, and reporting either as a plain Error would exit 1, which the contract
    // reads as "the gate ran and found a regression".
    expect(() => selectNamedCases([fakeCase('a'), fakeCase('a')], [])).toThrow(DatasetError);
    expect(() => selectNamedCases([fakeCase('a')], ['nope'])).toThrow(UsageError);
  });

  it('names an id the dataset does not have', () => {
    expect(() => selectNamedCases([fakeCase('a')], ['a', 'nope'])).toThrow('unknown case id(s): nope');
  });

  it('names an id repeated in the argument', () => {
    // `--cases a,a` selects one case and asks for two. Counting would not notice: the
    // filter is set-membership, so selected.length is 1 against caseIds.length 2 — but the
    // version that compared those two numbers passed `--cases a,b` against a dataset with
    // no `a` and two `b`s, which is 2 === 2.
    expect(() => selectNamedCases([fakeCase('a')], ['a', 'a'])).toThrow('repeated case id(s): a');
  });
});
