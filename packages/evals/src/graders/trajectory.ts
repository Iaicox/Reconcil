/**
 * G1 trajectory (04-testing.md §5): the case's `tools_expected` were all called, no write
 * tool was called that the case did not sanction, and a refusal (`no_tools`) called nothing.
 *
 * There is no allowlist. It used to be exhaustive — every call had to appear in
 * `tools_allowed` — which scored path conformance rather than correctness: on a live run
 * every "disallowed tool" failure was one extra READ (`directory_list_entities` on a
 * question about the user's own wallets, `analytics_list_events` on a partial-payment
 * question) alongside an answer that was right and cited. Reading more than the minimum is
 * not a defect; a read tool cannot change anything. An unsanctioned WRITE can, so that is
 * what the metric bans, using the registry's own annotations (dataset.ts WRITE_TOOLS) so a
 * newly registered write tool is covered without touching the dataset.
 */
import { WRITE_TOOLS, type EvalExpect } from '../dataset.js';
import { calledTools, type GradeResult, type Transcript } from '../transcript.js';

export function gradeTrajectory(t: Transcript, expected: EvalExpect): GradeResult {
  const called = calledTools(t);
  const calledSet = new Set(called);

  // A refusal's structural half: declining and then calling tools anyway is a failure
  // even when the prose is a clean decline (G4 grades the prose).
  if (expected.no_tools === true) {
    if (called.length > 0) {
      return { pass: false, detail: `refusal case called tool(s): ${[...calledSet].join(', ')}` };
    }
    return { pass: true, detail: 'trajectory ok' };
  }

  const sanctioned = new Set([...(expected.tools_expected ?? []), ...(expected.writes_allowed ?? [])]);
  const unsanctionedWrites = [...calledSet].filter((n) => WRITE_TOOLS.has(n) && !sanctioned.has(n));
  if (unsanctionedWrites.length > 0) {
    return { pass: false, detail: `called unsanctioned write tool(s): ${unsanctionedWrites.join(', ')}` };
  }

  const missing = (expected.tools_expected ?? []).filter((n) => !calledSet.has(n));
  if (missing.length > 0) {
    return { pass: false, detail: `missing expected tool(s): ${missing.join(', ')}` };
  }
  return { pass: true, detail: 'trajectory ok' };
}
