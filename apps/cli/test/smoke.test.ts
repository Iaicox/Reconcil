import type { EvalCase } from '@reconcil/evals';
import { describe, expect, it } from 'vitest';

import { SMOKE_IDS, buildSmokeIds, selectSmokeDataset } from '../src/evals/smoke.js';

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
    expect(() => selectSmokeDataset(all, SMOKE_IDS)).toThrow(/missing: recon-status-001/);
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
    expect(all.filter((c) => SMOKE_IDS.has(c.id))).toHaveLength(SMOKE_IDS.size); // the trap
    expect(() => selectSmokeDataset(all, SMOKE_IDS)).toThrow(/missing: recon-status-001/);
    expect(() => selectSmokeDataset(all, SMOKE_IDS)).toThrow(/duplicate ids in dataset\): cover-001/);
  });

  it('throws naming every missing id when several drift at once', () => {
    const all = [fakeCase('cover-001')];
    expect(() => selectSmokeDataset(all, SMOKE_IDS)).toThrow(
      /missing: flow-001, gas-001, guard-001, inj-001, recon-status-001/,
    );
  });

  it('throws over an empty dataset rather than passing vacuously with ZERO cases', () => {
    // Asserted on the DEFECT (which ids are gone), not on the counts: the counts are now a
    // suffix precisely because they are the least informative part of the message.
    expect(() => selectSmokeDataset([], SMOKE_IDS)).toThrow(/missing: cover-001, flow-001/);
    expect(() => selectSmokeDataset([], SMOKE_IDS)).toThrow(/selected 0 of 6 named ids/);
  });

  it('throws naming duplicates when the source dataset carries a repeated id', () => {
    const all = [fakeCase('a'), fakeCase('a'), fakeCase('b')];
    expect(() => selectSmokeDataset(all, new Set(['a', 'b']))).toThrow(/unexpected \(duplicate ids in dataset\): a/);
  });

  it('defaults to the real SMOKE_IDS set', () => {
    const all = [...SMOKE_IDS].map((id) => fakeCase(id));
    expect(selectSmokeDataset(all)).toHaveLength(SMOKE_IDS.size);
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
    expect(SMOKE_IDS.size).toBe(6);
  });
});
