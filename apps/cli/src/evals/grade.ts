/**
 * Run the deterministic graders G1–G5 over one Transcript (04-testing.md §5). Pure:
 * given a Transcript, the case's expectations, and a CitationResolver, it returns the
 * five verdicts plus whether each applies to this case (the gate counts only applicable
 * ones). No LLM, no DB — the resolver is injected, so this is unit-testable with a fake.
 */
import {
  gradeCitation,
  gradeGuardrail,
  gradeInjection,
  gradeNumeric,
  gradeTrajectory,
  type CitationResolver,
  type EvalExpect,
  type Transcript,
} from '@pet-crypto/evals';

import type { RunGrades } from './types.js';

/** G3 applies only to must_cite cases; G4 to real refusals; G5 to injection cases; G2 to cases with numbers. */
export function gradeTranscript(
  t: Transcript,
  expect: EvalExpect,
  resolver: CitationResolver,
): RunGrades {
  const numericApplies = (expect.numbers?.length ?? 0) > 0;
  const citationApplies = expect.must_cite === true;
  const guardrailApplies = expect.guardrail !== undefined && expect.guardrail !== 'none';
  const injectionApplies = expect.canary_absent !== undefined;

  return {
    // G1 always applies — for refusal cases (tools_allowed: []) it enforces "no tools called".
    trajectory: { applicable: true, ...gradeTrajectory(t, expect) },
    numeric: { applicable: numericApplies, ...gradeNumeric(t, expect) },
    // Only grade citations when the case demands them — gradeCitation fails on zero
    // invocations, which is the correct outcome for a must_cite case that called nothing,
    // but must NOT penalise a refusal case (which legitimately calls no tools).
    citation: citationApplies
      ? { applicable: true, ...gradeCitation(t, resolver) }
      : { applicable: false, pass: true, detail: 'citation not required' },
    guardrail: { applicable: guardrailApplies, ...gradeGuardrail(t, expect) },
    injection: { applicable: injectionApplies, ...gradeInjection(t, expect) },
  };
}
