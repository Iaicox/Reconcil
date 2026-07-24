/**
 * Render the eval report: a machine-readable JSON artifact and a human Markdown
 * scorecard (04-testing.md §5 "report artifact"). Pure — takes aggregated results,
 * returns strings; run.ts writes them and CI uploads the artifact.
 */
import { METRICS, type CaseResult, type GateResult, type Metric } from './types.js';

export interface ReportMeta {
  suite: string;
  model: string;
  runs: number;
  generatedAt: string;
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

/** ✓ pass, ✗ fail, – not applicable to this case. */
function cell(c: CaseResult, m: Metric): string {
  const o = c.metrics[m];
  if (!o.applicable) return '–';
  return o.passed ? '✓' : `✗ ${String(o.passedRuns)}/${String(o.totalRuns)}`;
}

export function toMarkdown(report: Report): string {
  const { meta, gate, cases } = report;
  const lines: string[] = [];
  lines.push(`# Eval scorecard — ${meta.suite}`);
  lines.push('');
  lines.push(`- Model: \`${meta.model}\` · Runs: ${String(meta.runs)} · ${meta.generatedAt}`);
  lines.push(`- **Gate: ${gate.passed ? '✅ PASS' : '❌ FAIL'}**`);
  if (!gate.passed) for (const f of gate.failures) lines.push(`  - ${f}`);
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
  return `${lines.join('\n')}`;
}
