/**
 * Eval harness (04-testing.md): golden fixtures, the eval dataset + loader, the
 * fixture-seeded DB harness, and the deterministic graders G1–G5. Everything here is
 * hermetic (no LLM, no network) — the Agent-SDK runner + demo gate (PR #15) import this
 * surface and bind the tools in-process against a fixture-seeded database.
 */

// Dataset (§5)
export {
  loadDataset,
  parseDataset,
  guardrailKind,
  evalCaseSchema,
  datasetSchema,
  type EvalCase,
  type EvalExpect,
  type EvalSetup,
  type GuardrailKind,
} from './dataset.js';

// Fixture-seeded DB harness (§2)
export { seedGoldenWallet, recordedNativeBalance, type SeededWallet } from './seed.js';

// The graded unit + number helpers
export {
  calledTools,
  canonicalDecimal,
  extractNumbers,
  type Transcript,
  type ToolInvocation,
  type GradeResult,
} from './transcript.js';

// Deterministic graders (§5)
export { gradeTrajectory } from './graders/trajectory.js';
export { gradeNumeric } from './graders/numeric.js';
export { gradeCitation, type CitationResolver } from './graders/citation.js';
export { gradeGuardrail } from './graders/guardrail.js';
export { gradeInjection } from './graders/injection.js';
