/**
 * Render the eval report: a machine-readable JSON artifact and a human Markdown
 * scorecard (04-testing.md §5 "report artifact"). Pure — takes aggregated results,
 * returns strings; run.ts writes them and CI uploads the artifact.
 */
import { METRICS, type CaseResult, type GateResult, type Metric } from './types.js';

export interface ReportMeta {
  suite: string;
  /** What was REQUESTED — may be an undated alias such as `claude-opus-4-8`. */
  model: string;
  /**
   * What actually ANSWERED, as reported by the API. An undated alias re-points without
   * warning, so two scorecards are only comparable when this matches; without it a red
   * gate cannot be told apart from a moved baseline. Absent if no session got a response.
   */
  resolvedModel?: string;
  runs: number;
  generatedAt: string;
  /**
   * Set when the suite did not finish. A session can die on something that has nothing to
   * do with the cases — an API usage limit, a dropped connection — and the run to that
   * point is paid for and not repeatable, so it is reported rather than discarded. Its
   * presence also says the rollup below covers only `completedCases`, which is why an
   * aborted report never claims a gate verdict.
   */
  aborted?: { completedCases: number; totalCases: number; reason: string };
}

const METRIC_LABEL: Record<Metric, string> = {
  trajectory: 'G1',
  numeric: 'G2',
  citation: 'G3',
  guardrail: 'G4',
  injection: 'G5',
};

export interface Report {
  meta: ReportMeta;
  gate: GateResult;
  cases: CaseResult[];
}

export function buildReport(meta: ReportMeta, cases: CaseResult[], gate: GateResult): Report {
  return { meta, gate, cases };
}

export function toJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * How much of an answer the Markdown carries. The Markdown is echoed into the CI log as
 * well as uploaded, so it excerpts; `scorecard.json` always holds the answer in full.
 */
const ANSWER_EXCERPT = 1500;

/** ✓ pass, ✗ fail, – not applicable to this case. */
function cell(c: CaseResult, m: Metric): string {
  const o = c.metrics[m];
  if (!o.applicable) return '–';
  return o.passed ? '✓' : `✗ ${String(o.passedRuns)}/${String(o.totalRuns)}`;
}

/** The answer as a Markdown blockquote, excerpted — multi-line answers stay quoted throughout. */
function quoteAnswer(answer: string): string {
  const text = answer.length > ANSWER_EXCERPT
    ? `${answer.slice(0, ANSWER_EXCERPT)}… [truncated — full text in scorecard.json]`
    : answer;
  const body = text.trim() === '' ? '(empty answer)' : text;
  return body.split('\n').map((line) => `> ${line}`).join('\n');
}

/**
 * The transcript appendix: for every case with a failing applicable metric, each run's
 * grader reason, the tools it called, and what it answered. This is the half of the report
 * that makes a red gate diagnosable without paying for a second run — the per-case matrix
 * above says only which letter failed.
 */
function failingCaseDetail(cases: CaseResult[]): string[] {
  const failing = cases.filter((c) => METRICS.some((m) => c.metrics[m].applicable && !c.metrics[m].passed));
  if (failing.length === 0) return [];

  const lines = ['## Failing cases', ''];
  for (const c of failing) {
    lines.push(`### ${c.id} (Face ${c.face})`);
    lines.push('');
    for (const m of METRICS) {
      const o = c.metrics[m];
      if (!o.applicable || o.passed) continue;
      lines.push(`- **${METRIC_LABEL[m]} ${m}** — ${String(o.passedRuns)}/${String(o.totalRuns)} runs passed`);
      for (const [i, r] of c.runs.entries()) {
        if (r.grades[m].pass) continue;
        lines.push(`  - run ${String(i + 1)}: ${r.grades[m].detail}`);
      }
    }
    lines.push('');
    for (const [i, r] of c.runs.entries()) {
      const path = r.tools.length > 0 ? r.tools.join(' → ') : '(no tools called)';
      lines.push(`**run ${String(i + 1)}** — tools: ${path}`);
      lines.push('');
      lines.push(quoteAnswer(r.answer));
      lines.push('');
    }
  }
  return lines;
}

export function toMarkdown(report: Report): string {
  const { meta, gate, cases } = report;
  const lines: string[] = [];
  lines.push(`# Eval scorecard — ${meta.suite}`);
  lines.push('');
  const resolved = meta.resolvedModel && meta.resolvedModel !== meta.model
    ? ` (resolved: \`${meta.resolvedModel}\`)`
    : '';
  lines.push(`- Model: \`${meta.model}\`${resolved} · Runs: ${String(meta.runs)} · ${meta.generatedAt}`);
  if (meta.aborted) {
    // Never a ✅ on a partial suite: the cases that never ran cannot be assumed to pass.
    const { completedCases, totalCases, reason } = meta.aborted;
    lines.push(`- **Gate: ⚠️ INCOMPLETE — ${String(completedCases)} of ${String(totalCases)} cases ran**`);
    lines.push(`  - the suite stopped early: ${reason}`);
    lines.push('  - everything below covers only the cases that ran, and is not a gate verdict');
  } else {
    lines.push(`- **Gate: ${gate.passed ? '✅ PASS' : '❌ FAIL'}**`);
    if (!gate.passed) for (const f of gate.failures) lines.push(`  - ${f}`);
  }
  lines.push('');

  // Per-metric rollup.
  lines.push('| Metric | Applicable | Passed | Threshold |');
  lines.push('|---|---|---|---|');
  for (const m of METRICS) {
    const r = gate.rollup[m];
    lines.push(`| ${METRIC_LABEL[m]} ${m} | ${String(r.applicableCases)} | ${String(r.passedCases)} | ${r.threshold} |`);
  }
  lines.push('');

  // Per-case matrix.
  lines.push('| Case | Face | G1 | G2 | G3 | G4 | G5 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const c of cases) {
    const cells = METRICS.map((m) => cell(c, m)).join(' | ');
    lines.push(`| ${c.id} | ${c.face} | ${cells} |`);
  }
  lines.push('');
  lines.push(...failingCaseDetail(cases));
  return `${lines.join('\n')}`;
}
