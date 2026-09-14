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
    // `tools_expected` ONLY. Summing in `tools_any_of` (as an earlier round did, to stop a
    // broadened case dropping out) makes this assertion weaker than its own name: a case
    // broadened to `[recon_status, analytics_list_events]` would keep `recon_status` in the
    // set while no case REQUIRED it any more, so G1 would pass a run that never called it.
    // "Exercised" has to mean required. No Face B case uses tools_any_of today — the
    // scarcity test below pins the whole any-of list at ['flow-002'] — so if one ever does,
    // this fails and the decision gets made deliberately rather than absorbed silently.
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

  it('every non-guardrail case names the tool(s) it expects, required or accepted', () => {
    for (const c of cases) {
      if (c.expect.guardrail && c.expect.guardrail !== 'none') continue;
      const named = (c.expect.tools_expected?.length ?? 0) + (c.expect.tools_any_of?.length ?? 0);
      expect(named).toBeGreaterThan(0);
    }
  });

  it('keeps tools_any_of scarce — a case that accepts either tool stops testing tool selection', () => {
    // Not a style rule: the field is only legitimate where a graded run produced the
    // alternative AND both tools compute the figure server-side (dataset.ts). If this list
    // grows, the growth should be a decision someone made, not drift.
    const anyOf = cases.filter((c) => c.expect.tools_any_of !== undefined).map((c) => c.id);
    expect(anyOf).toEqual(['flow-002']);
    // The sibling stablecoin cases stay single-tool on purpose — they name stablecoins
    // outright, so the specialised tool IS the expected answer.
    for (const id of ['stable-001', 'stable-002', 'flow-001', 'flow-003-self-transfer']) {
      const sibling = cases.find((c) => c.id === id);
      // Asserted to EXIST first: `find(...)?.expect.tools_any_of` is undefined for a case
      // that was renamed away, which is exactly what the assertion below demands — the
      // guard would go quiet at the moment the drift it watches for happens.
      expect(sibling, `sibling case ${id} is gone — rename it here or restore it`).toBeDefined();
      expect(sibling!.expect.tools_any_of).toBeUndefined();
    }
  });

  it('the refusal cases are the only ones that forbid tools outright', () => {
    // `no_tools` is the structural half of a guardrail case (G1); if it ever drifted onto a
    // question that should be answered, that case would be unpassable by construction.
    const noTools = cases.filter((c) => c.expect.no_tools === true).map((c) => c.id).sort();
    const guardrails = cases
      .filter((c) => c.expect.guardrail && c.expect.guardrail !== 'none')
      .map((c) => c.id)
      .sort();
    expect(noTools).toEqual(guardrails);
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
      tools_any_of: c.expect.tools_any_of ?? [],
      writes_allowed: c.expect.writes_allowed ?? [],
      no_tools: c.expect.no_tools ?? false,
      guardrail: c.expect.guardrail ?? null,
      canary: c.expect.canary_absent ?? null,
    }));
    expect(index).toMatchSnapshot();
  });
});
