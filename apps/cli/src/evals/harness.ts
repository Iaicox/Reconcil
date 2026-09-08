/**
 * The eval orchestration core (04-testing.md §5): for each case, seed the fixture DB
 * once, run the agent `runs` times, grade each transcript (G1–G5), and aggregate.
 * LLM- and DB-agnostic — `seedCase` and `produce` are injected, so this drives against
 * a fake session producer with no API key in the hermetic `test` job, and against the
 * real Tool Runner + Postgres in `evals-*`.
 */
import { calledTools, type EvalCase } from '@reconcil/evals';

import { aggregateCase } from './gate.js';
import { gradeTranscript } from './grade.js';
import type { CaseResult, CaseSeeder, ResolverFactory, RunResult, SessionProducer } from './types.js';

export interface HarnessDeps {
  /** Truncate + seed the fixture for this case; returns a tenant-scoped ctx. */
  seedCase: CaseSeeder;
  /** Produce one graded transcript per run (real: Tool Runner; test: canned). */
  produce: SessionProducer;
  /** Build a per-transcript citation resolver (real: DB reads; test: fake). */
  makeResolver: ResolverFactory;
  /** Optional progress hook (per completed case), for CLI logging. */
  onCase?: (result: CaseResult) => void;
}

export async function runSuite(
  dataset: EvalCase[],
  runs: number,
  deps: HarnessDeps,
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const evalCase of dataset) {
    const runResults: RunResult[] = [];
    for (let runIndex = 0; runIndex < runs; runIndex++) {
      // Every run gets a clean world. This used to reseed only for Face B, on the premise
      // that "Face A tools are read-only" — which is false: dir-001 and track-001 are Face A
      // and call WRITE tools. A live dir-001 run showed exactly that, run 1 creating the
      // address-book entity and runs 2–3 finding it already there and (correctly) declining
      // to re-create it, scored 1/3. Face was never the right discriminator; with the
      // trajectory allowlist gone, no case can promise what the model will call at all.
      // seedCase truncates first, so this is safe; it costs one local reseed per run
      // (D3, 04-testing.md §5) against ~90 LLM sessions, which is not the expensive half.
      const env = await deps.seedCase(evalCase);
      const transcript = await deps.produce({ eval: evalCase, ctx: env.ctx, runIndex });
      const resolver = await deps.makeResolver(env.ctx, transcript);
      // The transcript is kept alongside the verdicts, not discarded with the session —
      // it is the only record of what the model did, and a paid run is not repeatable.
      runResults.push({
        grades: gradeTranscript(transcript, evalCase.expect, resolver),
        tools: calledTools(transcript),
        answer: transcript.finalAnswer,
      });
    }
    const result = aggregateCase(evalCase.id, evalCase.face, runResults);
    results.push(result);
    deps.onCase?.(result);
  }
  return results;
}
