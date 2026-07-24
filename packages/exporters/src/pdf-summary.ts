/**
 * `export_pdf_summary` renderer (contract §6.5): a one-page PDF of the month's
 * headline figures + the audit manifest. Figures are rounded half-up to 2dp for
 * display (the export boundary, ADR-004). The PDF is prominently labeled DRAFT
 * (P8). Output bytes are not asserted byte-for-byte in tests (pdfkit embeds a
 * creation timestamp), but the manifest is deterministic given fixed provenance.
 */
import PDFDocument from 'pdfkit';

import { roundHalfUp } from './decimal.js';
import { buildManifest, serializeManifest } from './manifest.js';
import { sha256 } from './sha256.js';
import type { PdfSummaryInput, RenderedExport, RenderedFile } from './types.js';

function money(value: string | undefined, currency: string): string {
  return value === undefined ? 'n/a' : `${roundHalfUp(value, 2)} ${currency}`;
}

function renderPdfBytes(input: PdfSummaryInput): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'Monthly Close Summary (DRAFT)' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on('error', reject);

    doc.fontSize(20).text('Monthly Close Summary');
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor('red').text('DRAFT — review required (not a filed report)');
    doc.fillColor('black').moveDown();

    doc.fontSize(11);
    doc.text(`Period: ${input.period.start} → ${input.period.end}`);
    doc.text(`Valuation currency: ${input.currency}`);
    doc.text(`Wallets in scope: ${String(input.scope.addresses.length)}`);
    doc.moveDown();

    doc.fontSize(13).text('Portfolio value');
    doc.fontSize(11);
    doc.text(`  Opening: ${money(input.openingTotalFiat, input.currency)}`);
    doc.text(`  Closing: ${money(input.closingTotalFiat, input.currency)}`);
    doc.moveDown();

    doc.fontSize(13).text('Activity');
    doc.fontSize(11);
    doc.text(`  Net flows: ${money(input.netFlowsFiat, input.currency)}`);
    doc.text(`  Gas spend: ${money(input.gasTotalFiat, input.currency)}`);
    doc.moveDown();

    doc.fontSize(13).text('Top counterparties');
    doc.fontSize(11);
    if (input.topCounterparties.length === 0) {
      doc.text('  (none)');
    } else {
      for (const cp of input.topCounterparties) {
        doc.text(`  ${cp.name}: ${roundHalfUp(cp.fiatTurnover, 2)} ${input.currency}`);
      }
    }
    doc.moveDown();

    doc.fontSize(9).fillColor('gray').text(
      `export_id ${input.provenance.exportId} · generated ${input.provenance.generatedAt}`,
    );

    doc.end();
  });
}

export async function renderPdfSummary(input: PdfSummaryInput): Promise<RenderedExport> {
  const pdf = await renderPdfBytes(input);
  const pdfFile: RenderedFile = { name: 'summary.pdf', content: pdf, sha256: sha256(pdf) };

  const manifest = buildManifest({
    kind: 'pdf_summary',
    period: input.period,
    currency: input.currency,
    scope: input.scope,
    provenance: input.provenance,
    files: [{ name: pdfFile.name, sha256: pdfFile.sha256 }],
    roundingResidues: [],
  });
  const manifestContent = serializeManifest(manifest);

  return {
    files: [pdfFile, { name: 'manifest.json', content: manifestContent, sha256: sha256(manifestContent) }],
    manifest,
    roundingResidues: [],
  };
}
