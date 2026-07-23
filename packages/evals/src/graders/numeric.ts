/**
 * G2 numeric (04-testing.md §5): every expected number appears in the final answer
 * (canonicalised exact string match — no tolerance; the tools are deterministic, so
 * is the truth). Plus anti-fabrication: every number in the answer must trace to some
 * tool result from the session — a hallucinated figure fails the case even when the
 * expected numbers are present.
 */
import type { EvalExpect } from '../dataset.js';
import { canonicalDecimal, extractNumbers, type GradeResult, type Transcript } from '../transcript.js';

export function gradeNumeric(t: Transcript, expected: EvalExpect): GradeResult {
  const answerNumbers = extractNumbers(t.finalAnswer);

  for (const { value, label } of expected.numbers ?? []) {
    const c = canonicalDecimal(value);
    if (c === null || !answerNumbers.has(c)) {
      return { pass: false, detail: `expected ${label} = ${value} not found in the answer` };
    }
  }

  const provided = new Set<string>();
  for (const inv of t.invocations) {
    for (const n of extractNumbers(JSON.stringify(inv.envelope.data))) provided.add(n);
  }
  for (const n of answerNumbers) {
    if (!provided.has(n)) {
      return { pass: false, detail: `fabricated number in answer: ${n} (not in any tool result)` };
    }
  }
  return { pass: true, detail: 'numeric ok' };
}
