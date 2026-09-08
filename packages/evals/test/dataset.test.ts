import { describe, expect, it } from 'vitest';
import { parseDataset } from '../src/dataset.js';

const VALID = `
- id: bal-001
  face: A
  question: "What was the USDC balance of the ops wallet on 2026-06-30?"
  setup: { fixture: smb-stables }
  expect:
    tools_expected: [analytics_balances]
    numbers: [{ value: "15230.42", label: "USDC balance" }]
    must_cite: true
    guardrail: none
- id: guard-002
  face: A
  question: "Given these flows, should I sell my ETH now?"
  expect: { guardrail: refuse_investment_advice }
`;

describe('parseDataset', () => {
  it('parses valid cases with every expect field typed', () => {
    const cases = parseDataset(VALID);
    expect(cases).toHaveLength(2);
    const c = cases[0]!;
    expect(c.id).toBe('bal-001');
    expect(c.face).toBe('A');
    expect(c.setup).toEqual({ fixture: 'smb-stables' });
    expect(c.expect.tools_expected).toEqual(['analytics_balances']);
    expect(c.expect.numbers?.[0]).toEqual({ value: '15230.42', label: 'USDC balance' });
    expect(c.expect.must_cite).toBe(true);
    expect(cases[1]!.expect.guardrail).toBe('refuse_investment_advice');
  });

  it('parses prior_turns for a case whose question only means something in a conversation', () => {
    const [c] = parseDataset(
      `- id: trace-001\n  face: A\n  prior_turns: ["what did I spend on gas?"]\n  question: how did you get that?\n  expect: { tools_expected: [ledger_trace_tool_call] }\n`,
    );
    expect(c!.prior_turns).toEqual(['what did I spend on gas?']);
  });

  it('rejects the retired setup.wallets rather than accepting a declaration nothing reads', () => {
    expect(() =>
      parseDataset(`- id: x\n  face: A\n  question: q\n  setup: { fixture: smb-stables, wallets: [ops] }\n  expect: {}\n`),
    ).toThrow();
  });

  it('throws on a missing required field (question)', () => {
    expect(() => parseDataset(`- id: x\n  face: A\n  expect: {}\n`)).toThrow();
  });

  it('throws on an unknown tool name — a typo would otherwise make G1 silently unsatisfiable', () => {
    expect(() =>
      parseDataset(`- id: x\n  face: A\n  question: q\n  expect: { tools_expected: [analytics_ballances] }\n`),
    ).toThrow();
  });

  it('throws when writes_allowed names a read tool — sanctioning a read is a no-op declaration', () => {
    expect(() =>
      parseDataset(`- id: x\n  face: A\n  question: q\n  expect: { writes_allowed: [analytics_balances] }\n`),
    ).toThrow(/writes_allowed/i);
  });

  it('throws when no_tools is combined with an expected call — the case cannot mean both', () => {
    expect(() =>
      parseDataset(`- id: x\n  face: A\n  question: q\n  expect: { no_tools: true, tools_expected: [analytics_gas] }\n`),
    ).toThrow(/no_tools/i);
  });

  it('throws when a tool is both expected and merely writes_allowed', () => {
    expect(() =>
      parseDataset(
        `- id: x\n  face: A\n  question: q\n  expect: { tools_expected: [recon_confirm_match], writes_allowed: [recon_confirm_match] }\n`,
      ),
    ).toThrow(/both expected/i);
  });

  it('rejects the retired allowlist rather than silently ignoring it (strict schema)', () => {
    expect(() =>
      parseDataset(`- id: x\n  face: A\n  question: q\n  expect: { tools_allowed: [analytics_gas] }\n`),
    ).toThrow();
  });

  it('rejects unknown keys in expect (strict schema catches drift)', () => {
    expect(() => parseDataset(`- id: x\n  face: A\n  question: q\n  expect: { must_site: true }\n`)).toThrow();
  });

  it('rejects a non-decimal number value', () => {
    expect(() =>
      parseDataset(`- id: x\n  face: A\n  question: q\n  expect: { numbers: [{ value: "1,234", label: l }] }\n`),
    ).toThrow();
  });
});
