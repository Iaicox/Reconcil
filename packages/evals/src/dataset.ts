/**
 * Eval dataset (04-testing.md §5): a typed, Zod-validated loader for `core-30.yaml`.
 * It fails loudly on malformed cases — an unknown tool name would otherwise make G1
 * silently unsatisfiable, and `tools_expected ⊄ tools_allowed` is an unsatisfiable
 * case. The deterministic graders and (PR #15) the Agent-SDK runner consume `EvalCase[]`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decimalString } from '@reconcil/core';
import { tools } from '@reconcil/mcp-tools';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Tool names validated against the live registry — a typo fails at load, not at grade time. */
const toolNames = tools.map((t) => t.name);
if (toolNames.length === 0) {
  throw new Error('the mcp-tools registry is empty — cannot build the eval tool-name enum');
}
const toolName = z.enum(toolNames as [string, ...string[]]);

/**
 * The tools that mutate tenant data, taken from the registry's own `readOnlyHint`
 * annotation rather than a list kept here — a newly added write tool is covered by G1 the
 * day it is registered, without anyone remembering to update the eval package.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(
  tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name),
);

export const guardrailKind = z.enum([
  'none',
  'refuse_investment_advice',
  'refuse_tax_advice',
  'refuse_price_prediction',
]);
export type GuardrailKind = z.infer<typeof guardrailKind>;

/**
 * G1's expectations (04-testing.md §5). There is deliberately no allowlist: an extra
 * READ is not a defect — the agent choosing to check `ledger_status`, or to look a label up
 * in the directory, is good behaviour that an exhaustive allowlist scored as failure. What
 * must not happen is an unsanctioned WRITE, and that is derived from the registry rather
 * than restated per case: any write tool outside `tools_expected ∪ writes_allowed` fails.
 *
 * `writes_allowed` is for a write the case permits but does not require — confirm-001 may
 * reasonably call `recon_suggest_matches` first to find the match id, or take it from
 * `recon_status`; requiring it would over-specify the path, and banning it would fail a
 * correct run. `no_tools` is the refusal cases' structural half: a decline calls nothing.
 *
 * `tools_any_of` is the disjunction `tools_expected` cannot express: a set of tools of which
 * AT LEAST ONE must be called, for a question two tools answer equally well. flow-002 asks
 * for "the net USDC flow" — both a flow question and a stablecoin question — and a live run
 * answered it correctly through `analytics_stablecoin_movements` while the case demanded
 * `analytics_flows`; G1 scored a miss for a choice that was not wrong.
 *
 * The bar for using it is deliberately high, because a case that accepts either tool no
 * longer tests tool selection at all. Broaden a case only when (a) a GRADED RUN produced the
 * alternative — never speculatively — and (b) both tools compute the figure server-side. (b)
 * is what rules out e.g. answering cp-002 from `analytics_list_events`: the rows are there,
 * but the agent would have to sum them, and the LLM never computes (P1). The field is
 * restricted to READ tools — see the refine below for why a disjunction over writes cannot
 * mean what it looks like it means.
 */
const expectSchema = z
  .object({
    tools_expected: z.array(toolName).optional(),
    tools_any_of: z
      .array(toolName)
      // Message stated, not left to Zod's generic "too_small": the rule is a judgment
      // ("a set of one is a plain expectation"), and its test pins this text rather than
      // a bare .toThrow() that any unrelated schema error would also satisfy.
      .min(2, { message: 'tools_any_of needs at least two tools — a set of one is a plain tools_expected' })
      .optional(),
    writes_allowed: z.array(toolName).optional(),
    no_tools: z.boolean().optional(),
    numbers: z.array(z.object({ value: decimalString, label: z.string() }).strict()).optional(),
    must_cite: z.boolean().optional(),
    guardrail: guardrailKind.optional(),
    canary_absent: z.string().optional(),
  })
  .strict()
  .refine((e) => (e.writes_allowed ?? []).every((t) => WRITE_TOOLS.has(t)), {
    message: 'writes_allowed may only name write tools — sanctioning a read tool is a no-op',
  })
  .refine(
    (e) =>
      !(
        e.no_tools === true &&
        ((e.tools_expected?.length ?? 0) > 0 ||
          (e.tools_any_of?.length ?? 0) > 0 ||
          (e.writes_allowed?.length ?? 0) > 0)
      ),
    { message: 'no_tools cannot be combined with tools_expected, tools_any_of or writes_allowed' },
  )
  .refine(
    (e) => {
      const expected = new Set(e.tools_expected ?? []);
      return (e.writes_allowed ?? []).every((t) => !expected.has(t));
    },
    { message: 'a tool cannot be both expected and merely writes_allowed' },
  )
  // A duplicate would shrink the set behind the .min(2) that enforces "a set of one is a
  // plain expectation" — [analytics_flows, analytics_flows] is exactly that, spelled twice.
  .refine((e) => new Set(e.tools_any_of ?? []).size === (e.tools_any_of?.length ?? 0), {
    message: 'tools_any_of may not repeat a tool',
  })
  // tools_expected already forces the call, so an any-of set containing it is satisfied by
  // construction and constrains nothing — the defect the retired allowlist had.
  .refine(
    (e) => {
      const expected = new Set(e.tools_expected ?? []);
      return (e.tools_any_of ?? []).every((t) => !expected.has(t));
    },
    { message: 'tools_any_of may not name a tool that tools_expected already requires' },
  )
  // READ tools only. A disjunction cannot express "whichever one you picked, only that
  // one": G1 sees the set, not the choice, so an any-of over write tools would have to
  // sanction every member — and `[recon_confirm_match, recon_reject_match]` would then
  // pass for an agent that called BOTH, confirming a match and then rejecting it. Reads
  // are never banned, so restricting the field removes the question instead of answering
  // it badly. A case that genuinely needs alternative WRITES needs a different notion.
  .refine((e) => (e.tools_any_of ?? []).every((t) => !WRITE_TOOLS.has(t)), {
    message: 'tools_any_of may only name read tools — a disjunction over writes would sanction every member',
  })
;

// There is deliberately NO "tools_any_of ∩ writes_allowed" rule. It would be unreachable:
// writes_allowed may only name write tools and tools_any_of may only name read tools, so
// the intersection is empty for anything that gets that far. One was written, and the test
// that named it passed on the read-tools rule instead — a rule that cannot fire, guarded by
// a test that cannot prove it does.

// `wallets` used to sit here. It was validated and then read by nobody: the seeder tracks
// whatever single wallet the fixture role seeds, and no fixture has a labelled or a second
// wallet. bal-001 asked for "the ops wallet" and the agent correctly answered that no such
// wallet exists, 3 runs of 3. A field that only ever describes is worse than no field, so
// it is gone; multi-wallet fixtures are a known gap (09-known-gaps.md), not a declaration.
const setupSchema = z.object({ fixture: z.string().min(1) }).strict();

export const evalCaseSchema = z
  .object({
    id: z.string().min(1),
    face: z.enum(['A', 'B']),
    question: z.string().min(1),
    /**
     * User turns asked and answered BEFORE the graded question, for a case whose question
     * only means something in a conversation — "how did you arrive at the gas figure from
     * my previous question". Each is a real agent turn against the same session and
     * database, so the tool_calls it makes are persisted and referable; only the graded
     * turn's own invocations are graded (agent.ts).
     */
    prior_turns: z.array(z.string().min(1)).optional(),
    setup: setupSchema.optional(),
    expect: expectSchema,
  })
  .strict();

export const datasetSchema = z.array(evalCaseSchema);

export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalExpect = EvalCase['expect'];
export type EvalSetup = z.infer<typeof setupSchema>;

/** Parse + validate dataset YAML text. Throws (ZodError / YAMLParseError) on any defect. */
export function parseDataset(text: string): EvalCase[] {
  return datasetSchema.parse(parseYaml(text));
}

/** Read + parse a dataset file (e.g. `fixtures/evals/core-30.yaml`). */
export function loadDataset(path: string): EvalCase[] {
  return parseDataset(readFileSync(path, 'utf8'));
}

/** Absolute path to the bundled core-30 dataset — resolves from both src (tsx) and dist. */
export function coreDatasetPath(): string {
  return fileURLToPath(new URL('../fixtures/evals/core-30.yaml', import.meta.url));
}
