/**
 * The eval orchestration core (04-testing.md §5): for each case, seed the fixture DB
 * once, run the agent `runs` times, grade each transcript (G1–G5), and aggregate.
 * LLM- and DB-agnostic — `seedCase` and `produce` are injected, so this drives against
 * a fake session producer with no API key in the hermetic `test` job, and against the
 * real Tool Runner + Postgres in `evals-*`.
 */
import type { EvalCase } from '@reconcil/evals';

import { aggregateCase } from './gate.js';
import { gradeTranscript } from './grade.js';
import type { CaseResult, CaseSeeder, ResolverFactory, RunGrades, SessionProducer } from './types.js';

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
    // Face A tools are read-only, so seed once per case and share the static data across
    // runs (only the agent session and its persisted tool_calls differ). Face B tools
    // WRITE — a confirm flips a leg suggested→confirmed, so run 2's suggest would find that
    // settlement already consumed and confirm would fail; each run needs a clean scenario.
    // seedCase truncates first, so re-seeding per run is safe (D3, 04-testing.md §5).
    let env = await deps.seedCase(evalCase);
    const runGrades: RunGrades[] = [];
    for (let runIndex = 0; runIndex < runs; runIndex++) {
      if (runIndex > 0 && evalCase.face === 'B') env = await deps.seedCase(evalCase);
      const transcript = await deps.produce({ eval: evalCase, ctx: env.ctx, runIndex });
      const resolver = await deps.makeResolver(env.ctx, transcript);
      runGrades.push(gradeTranscript(transcript, evalCase.expect, resolver));
    }
    const result = aggregateCase(evalCase.id, evalCase.face, runGrades);
    results.push(result);
    deps.onCase?.(result);
  }
  return results;
}
