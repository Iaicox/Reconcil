import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadDataset } from '../src/dataset.js';

const DATASET = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'evals', 'core-30.yaml');

describe('core-30 dataset', () => {
  const cases = loadDataset(DATASET);

  it('loads and validates the full 30-case set (24 Face A + 6 Face B)', () => {
    expect(cases).toHaveLength(30);
    expect(cases.filter((c) => c.face === 'A').length).toBeGreaterThanOrEqual(22);
  });

  it('includes the Face B recon narrative (import → suggest → confirm → status → journal)', () => {
    const faceB = cases.filter((c) => c.face === 'B');
    expect(faceB.length).toBeGreaterThanOrEqual(6);
    // Every Face B case seeds the recon-smb scenario, and the five recon tools are all exercised.
    expect(faceB.every((c) => c.setup?.fixture === 'recon-smb')).toBe(true);
    const exercised = new Set(faceB.flatMap((c) => c.expect.tools_expected ?? []));
    for (const t of ['recon_import_invoices', 'recon_suggest_matches', 'recon_confirm_match', 'recon_status', 'export_journal_drafts']) {
      expect(exercised.has(t)).toBe(true);
    }
  });

  it('has unique ids', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the §5 case mix (Face A analytics + Face B recon)', () => {
    const ids = cases.map((c) => c.id).join(' ');
    for (const prefix of [
      'bal-', 'flow-', 'gas-', 'cp-', 'stable-', 'cover-', 'drill-', 'trace-', 'guard-', 'inj-',
      'import-', 'suggest-', 'confirm-', 'recon-status-', 'partial-', 'journal-',
    ]) {
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

  it('native cases carry DB-derived numbers; erc20/USDC cases stay numbers-free until that capture lands', () => {
    // Numbers come from numbers.itest.ts over the fixture-seeded DB, never hand-authored
    // (P1/P2). Only the native cases (balance/gas, freelancer) are ground-truthable now —
    // erc20 events can't reach chain_events yet (04-testing.md §2 unblocker a).
    const withNumbers = cases.filter((c) => c.expect.numbers !== undefined).map((c) => c.id).sort();
    expect(withNumbers).toEqual(['bal-002', 'cover-001', 'gas-001']);
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
