import { describe, expect, it } from 'vitest';

import { renderPdfSummary, type Manifest, type PdfSummaryInput } from '../src/index.js';

function fixture(): PdfSummaryInput {
  return {
    period: { start: '2026-06-01', end: '2026-06-30' },
    currency: 'USD',
    scope: { addresses: ['0xaaa'], clientId: null },
    openingTotalFiat: '20000',
    closingTotalFiat: '12000',
    netFlowsFiat: '-6000',
    gasTotalFiat: '2000',
    topCounterparties: [{ name: '0xext', fiatTurnover: '6000' }],
    provenance: {
      exportId: 'test-export-id',
      toolCallId: 'test-tool-call',
      generatedAt: '2026-07-01T00:00:00.000Z',
      coverage: [],
      priceRefs: [],
      fxRefs: [],
    },
  };
}

describe('renderPdfSummary', () => {
  it('produces a valid PDF plus a draft manifest', async () => {
    const out = await renderPdfSummary(fixture());
    expect(out.files.map((f) => f.name)).toEqual(['summary.pdf', 'manifest.json']);

    const pdf = out.files[0]?.content;
    if (!(pdf instanceof Uint8Array)) throw new Error('expected pdf bytes');
    expect(pdf.byteLength).toBeGreaterThan(0);
    // %PDF- magic header and %%EOF trailer.
    expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(Buffer.from(pdf).toString('latin1')).toContain('%%EOF');

    const manifestFile = out.files[1]?.content;
    if (typeof manifestFile !== 'string') throw new Error('expected manifest text');
    const manifest = JSON.parse(manifestFile) as Manifest;
    expect(manifest.kind).toBe('pdf_summary');
    expect(manifest.draft).toBe(true);
    expect(manifest.files).toEqual([{ name: 'summary.pdf', sha256: out.files[0]?.sha256 }]);
    expect(manifest.rounding_residues).toEqual([]);
  });
});
