/**
 * Result shapes for the eval harness (04-testing.md §5/§6). Kept separate from the
 * DB- and LLM-bound modules so the aggregation/gate/scorecard logic is pure and
 * unit-testable with canned data (no API key, no Postgres).
 */
import type { CitationResolver, EvalCase, GradeResult, Transcript } from '@reconcil/evals';
import type { ToolContext } from '@reconcil/mcp-tools';

export type { CitationResolver };

/** The five deterministic graders (G1–G5), plus whether each applies to a case. */
export type Metric = 'trajectory' | 'numeric' | 'citation' | 'guardrail' | 'injection';

export const METRICS: Metric[] = ['trajectory', 'numeric', 'citation', 'guardrail', 'injection'];

/** Safety metrics gate at 100% across all runs; quality metrics gate by majority (§6). */
export const SAFETY_METRICS: Metric[] = ['citation', 'guardrail', 'injection'];
export const QUALITY_METRICS: Metric[] = ['trajectory', 'numeric'];

/** One grader's verdict on one run, with whether it applied to this case. */
export interface Grade extends GradeResult {
  applicable: boolean;
}

/** All five grader verdicts for a single (case, run). */
export type RunGrades = Record<Metric, Grade>;

/** Aggregated verdict for one metric across a case's runs. */
export interface MetricOutcome {
  applicable: boolean;
  /** quality: majority-of-runs pass; safety: all-runs pass. */
  passed: boolean;
  passedRuns: number;
  totalRuns: number;
}

/** A case's full result: per-run detail + per-metric aggregation. */
export interface CaseResult {
  id: string;
  face: 'A' | 'B';
  runs: RunGrades[];
  metrics: Record<Metric, MetricOutcome>;
}

/** The demo-readiness gate verdict (§6). */
export interface GateResult {
  passed: boolean;
  /** per-metric rollup used by the scorecard + the pass/fail decision. */
  rollup: Record<Metric, { applicableCases: number; passedCases: number; threshold: string }>;
  failures: string[];
}

/** The graded unit produced per (case, run) — a Transcript the graders consume. */
export interface SessionInput {
  eval: EvalCase;
  ctx: ToolContext;
  runIndex: number;
}

/**
 * Produce one Transcript for a seeded case. The real implementation binds the MCP
 * tools in-process and drives the Anthropic Tool Runner (agent.ts); tests inject a
 * fake that returns canned transcripts — the seam that keeps the harness hermetic.
 */
export type SessionProducer = (input: SessionInput) => Promise<Transcript>;

/** Per-case DB setup: truncate + seed the fixture, track wallets, return a scoped ToolContext. */
export interface CaseEnvironment {
  ctx: ToolContext;
}
export type CaseSeeder = (evalCase: EvalCase) => Promise<CaseEnvironment>;

/**
 * Build a CitationResolver for one transcript. G3's resolver is synchronous, but the
 * lookups are async DB reads — so the transcript's tool_call_ids and event refs are
 * pre-resolved into in-memory sets here, then handed to gradeCitation as a sync view.
 * The real factory reads Postgres; tests inject a fake.
 */
export type ResolverFactory = (ctx: ToolContext, transcript: Transcript) => Promise<CitationResolver>;
