import type { EvalCase } from '@reconcil/evals';
import { describe, expect, it } from 'vitest';

import { SMOKE_IDS, selectSmokeDataset } from '../src/evals/smoke.js';

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

  it('throws naming every missing id when several drift at once', () => {
    const all = [fakeCase('cover-001')];
    expect(() => selectSmokeDataset(all, SMOKE_IDS)).toThrow(
      /missing: flow-001, gas-001, guard-001, inj-001, recon-status-001/,
    );
  });

  it('throws over an empty dataset rather than passing vacuously with ZERO cases', () => {
    expect(() => selectSmokeDataset([], SMOKE_IDS)).toThrow(/expected 6 cases, got 0/);
  });

  it('throws naming duplicates when the source dataset carries a repeated id', () => {
    const all = [fakeCase('a'), fakeCase('a'), fakeCase('b')];
    expect(() => selectSmokeDataset(all, new Set(['a', 'b']))).toThrow(/unexpected \(duplicate ids in dataset\): a/);
  });

  it('defaults to the real SMOKE_IDS set', () => {
    const all = [...SMOKE_IDS].map((id) => fakeCase(id));
    expect(selectSmokeDataset(all)).toHaveLength(SMOKE_IDS.size);
  });
  it('a duplicate id in the literal is loud, not a silently smaller smoke', () => {
    // The failure this guards: `new Set([...])` absorbs a repeat, `ids.size` drops to 5,
    // and selectSmokeDataset's `length === size` check is then satisfied by 5 cases — a
    // smoke one case smaller than intended, reporting a clean match. The dataset-side
    // duplicate check below is a different mistake and does not cover this one.
    const withDupe = ['cover-001', 'flow-001', 'cover-001'];
    expect(new Set(withDupe).size).not.toBe(withDupe.length);
    // SMOKE_IDS is built under that assertion, so the real one is intact:
    expect(SMOKE_IDS.size).toBe(6);
  });
});
