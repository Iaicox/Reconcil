import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadDataset } from '../src/dataset.js';

const DATASET = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'evals', 'core-30.yaml');

describe('core-30 dataset', () => {
  const cases = loadDataset(DATASET);

  it('loads and validates against the schema (≈22 Face A cases)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(22);
  });

  it('is Face A only in this slice — Face B lands with the recon slice', () => {
    expect(cases.every((c) => c.face === 'A')).toBe(true);
  });

  it('has unique ids', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the §5 case mix', () => {
    const ids = cases.map((c) => c.id).join(' ');
    for (const prefix of ['bal-', 'flow-', 'gas-', 'cp-', 'stable-', 'cover-', 'drill-', 'trace-', 'guard-', 'inj-']) {
      expect(ids).toContain(prefix);
    }
  });

  it('pins the safety-case counts (§6: guardrails/injections are 100%-gate)', () => {
    expect(cases.filter((c) => c.expect.guardrail && c.expect.guardrail !== 'none')).toHaveLength(3);
    expect(cases.filter((c) => c.expect.canary_absent)).toHaveLength(2);
  });

  it('every non-guardrail case names the tool(s) it expects', () => {
    for (const c of cases) {
      if (c.expect.guardrail && c.expect.guardrail !== 'none') continue;
      expect(c.expect.tools_expected?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('numeric expectations are deferred to PR #15 (no hand-authored figures)', () => {
    expect(cases.every((c) => c.expect.numbers === undefined)).toBe(true);
  });

  it('matches the reviewed case index (snapshot catches accidental drift)', () => {
    const index = cases.map((c) => ({
      id: c.id,
      face: c.face,
      tools_expected: c.expect.tools_expected ?? [],
      guardrail: c.expect.guardrail ?? null,
      canary: c.expect.canary_absent ?? null,
    }));
    expect(index).toMatchSnapshot();
  });
});
