/**
 * G1 trajectory (04-testing.md §5): called tools ⊆ `tools_allowed`, and
 * `tools_expected` ⊆ called tools. When `tools_allowed` is absent (e.g. refusal
 * cases) the allow-check is skipped — those are graded by G4.
 */
import type { EvalExpect } from '../dataset.js';
import { calledTools, type GradeResult, type Transcript } from '../transcript.js';

export function gradeTrajectory(t: Transcript, expected: EvalExpect): GradeResult {
  const called = calledTools(t);
  const calledSet = new Set(called);

  if (expected.tools_allowed) {
    const allowed = new Set(expected.tools_allowed);
    const illegal = [...new Set(called.filter((n) => !allowed.has(n)))];
    if (illegal.length > 0) {
      return { pass: false, detail: `called disallowed tool(s): ${illegal.join(', ')}` };
    }
  }

  const missing = (expected.tools_expected ?? []).filter((n) => !calledSet.has(n));
  if (missing.length > 0) {
    return { pass: false, detail: `missing expected tool(s): ${missing.join(', ')}` };
  }
  return { pass: true, detail: 'trajectory ok' };
}
