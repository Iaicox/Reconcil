/**
 * The audit manifest (P2, ADR-011): the export-side embodiment of provenance —
 * the export's own ids, the pinned price/FX refs, coverage, rounding residues,
 * and a sha256 for every emitted file. Every export is a DRAFT (`draft: true`,
 * P8). Serialized as pretty JSON so the manifest is diff-friendly and, given
 * fixed provenance inputs, byte-deterministic for golden tests.
 */
import type { ExportPeriod, ExportScope, Manifest, Provenance, RoundingResidue } from './types.js';

export interface ManifestArgs {
  kind: 'close_pack' | 'pdf_summary';
  period: ExportPeriod;
  currency: 'USD' | 'EUR';
  scope: ExportScope;
  provenance: Provenance;
  files: { name: string; sha256: string }[];
  roundingResidues: RoundingResidue[];
}

export function buildManifest(args: ManifestArgs): Manifest {
  return {
    schema_version: 1,
    export_id: args.provenance.exportId,
    tool_call_id: args.provenance.toolCallId,
    kind: args.kind,
    period: args.period,
    currency: args.currency,
    scope: {
      addresses: args.scope.addresses,
      ...(args.scope.clientId != null ? { client_id: args.scope.clientId } : {}),
    },
    generated_at: args.provenance.generatedAt,
    draft: true,
    coverage: args.provenance.coverage,
    price_refs: args.provenance.priceRefs,
    fx_refs: args.provenance.fxRefs,
    rounding_residues: args.roundingResidues,
    files: args.files,
  };
}

/** Canonical manifest serialization (pretty, trailing newline). */
export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
