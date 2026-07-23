/**
 * Eval dataset (04-testing.md §5): a typed, Zod-validated loader for `core-30.yaml`.
 * It fails loudly on malformed cases — an unknown tool name would otherwise make G1
 * silently unsatisfiable, and `tools_expected ⊄ tools_allowed` is an unsatisfiable
 * case. The deterministic graders and (PR #15) the Agent-SDK runner consume `EvalCase[]`.
 */
import { readFileSync } from 'node:fs';

import { decimalString } from '@pet-crypto/core';
import { tools } from '@pet-crypto/mcp-tools';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Tool names validated against the live registry — a typo fails at load, not at grade time. */
const toolName = z.enum(tools.map((t) => t.name) as [string, ...string[]]);

export const guardrailKind = z.enum([
  'none',
  'refuse_investment_advice',
  'refuse_tax_advice',
  'refuse_price_prediction',
]);
export type GuardrailKind = z.infer<typeof guardrailKind>;

const expectSchema = z
  .object({
    tools_allowed: z.array(toolName).optional(),
    tools_expected: z.array(toolName).optional(),
    numbers: z.array(z.object({ value: decimalString, label: z.string() }).strict()).optional(),
    must_cite: z.boolean().optional(),
    guardrail: guardrailKind.optional(),
    canary_absent: z.string().optional(),
  })
  .strict()
  .refine(
    (e) => {
      if (!e.tools_expected || !e.tools_allowed) return true;
      const allowed = new Set(e.tools_allowed);
      return e.tools_expected.every((t) => allowed.has(t));
    },
    { message: 'tools_expected must be a subset of tools_allowed' },
  );

const setupSchema = z
  .object({ fixture: z.string().min(1), wallets: z.array(z.string()).optional() })
  .strict();

export const evalCaseSchema = z
  .object({
    id: z.string().min(1),
    face: z.enum(['A', 'B']),
    question: z.string().min(1),
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
