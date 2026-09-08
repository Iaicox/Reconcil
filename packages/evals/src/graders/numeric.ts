/**
 * G2 numeric (04-testing.md §5): every expected number appears in the final answer
 * (canonicalised exact string match — no tolerance; the tools are deterministic, so
 * is the truth). Plus anti-fabrication: every number in the answer must trace to some
 * tool result from the session — a hallucinated figure fails the case even when the
 * expected numbers are present.
 *
 * "Tool result" = the whole citation envelope (data AND citations), not just `data`:
 * an agent that cites provenance — printing a `tool_call_id` (ULID) or an event ref — is
 * doing exactly what P1/P2 want, and those ids are genuinely tool-returned, so their
 * incidental digits must not read as fabricated. (Confirmed on the first live Opus 4.8
 * run: a cited tool_call_id's shared time-prefix flagged a spurious "9".) tx-hash hex is
 * already dropped by extractNumbers; `meta.computed_at` is excluded to keep the wall-clock
 * timestamp out of the provided set. The transcript's `referenceDate` (the as-of date the
 * system prompt hands the model) is likewise a legitimate source: a freshness answer stating
 * "current as of 2026-07-17" must not have its day "17" read as fabricated.
 */
import type { EvalExpect } from '../dataset.js';
import { canonicalDecimal, extractNumbers, isoDatesIn, maskNonFigureSpans, type GradeResult, type Transcript } from '../transcript.js';

/** A short quoted window of the answer around the first occurrence of `canonical`, for CI logs. */
function contextFor(answer: string, canonical: string): string {
  // Blank the non-figure spans to spaces of equal length, so match indices still map onto
  // `answer` and the window quotes the token extractNumbers actually rejected.
  const scrubbed = maskNonFigureSpans(answer, (m) => ' '.repeat(m.length));
  for (const m of scrubbed.matchAll(/(?<![\d.])-?\d[\d,]*(?:\.\d+)?/g)) {
    if (m.index !== undefined && canonicalDecimal(m[0]) === canonical) {
      const start = Math.max(0, m.index - 25);
      const end = Math.min(answer.length, m.index + m[0].length + 25);
      const snippet = answer.slice(start, end).replace(/\s+/g, ' ').trim();
      return ` — near "${start > 0 ? '…' : ''}${snippet}${end < answer.length ? '…' : ''}"`;
    }
  }
  return '';
}

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
    const source = JSON.stringify({ data: inv.envelope.data, citations: inv.envelope.citations });
    for (const n of extractNumbers(source)) provided.add(n);
    // Masking is asymmetric on purpose. A date in the ANSWER is not a figure, so it is
    // masked away; but a date the TOOL returned is a legitimate source for the components
    // of that same date written out in prose — "settled on June 30, 2026" yields 30 and
    // 2026, and without this the envelope's own `2026-06-30` no longer covers them. The
    // rule to keep in mind: mask more in the answer (fewer false fabrications), mask less
    // in the provided set (also fewer false fabrications).
    for (const date of isoDatesIn(source)) {
      for (const part of date.split(/[-T:.]/)) {
        const c = canonicalDecimal(part);
        if (c !== null) provided.add(c);
      }
    }
  }
  // The reference date is context the prompt gave the model, not a computed figure. Its
  // components are added by splitting rather than through extractNumbers, which now strips
  // date-shaped text and would hand back nothing — the point here is the OTHER rendering,
  // "current as of July 17, 2026", where the day and year are loose numbers in prose.
  if (t.referenceDate) {
    for (const part of t.referenceDate.split('-')) {
      const c = canonicalDecimal(part);
      if (c !== null) provided.add(c);
    }
  }

  for (const n of answerNumbers) {
    if (!provided.has(n)) {
      return {
        pass: false,
        detail: `fabricated number in answer: ${n} (not in any tool result)${contextFor(t.finalAnswer, n)}`,
      };
    }
  }
  return { pass: true, detail: 'numeric ok' };
}
