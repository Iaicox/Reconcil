/**
 * `recon_import_invoices` (contract §6.4, write, idempotent) — import invoices from
 * CSV into `external_records`. The parse is pure (@reconcil/recon); this handler owns
 * the I/O edges: resolving `content` vs `file_path`, sanitizing hostile counterparty
 * names for the response (raw stays server-side, only the scrubbed value ships under
 * `untrusted`, C6/ADR-011), and persisting the tool_call before responding (C2).
 * Row-level problems are returned in `errors[]`, not thrown — a partial import is a
 * normal outcome.
 */
import {
  reconImportInvoicesInput, reconImportInvoicesOutput, sanitize,
  type ReconImportInvoicesOutput, type ReconImportedRecordView, type Warning,
} from '@reconcil/core';
import { parseInvoiceCsv, type ParseOptions } from '@reconcil/recon';

import type { ToolContext } from '../context.js';
import type { ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { readImportFile } from '../recon/import-fs.js';
import { importExternalRecords } from '../recon/repo.js';
import { resolveClientId } from '../scope.js';
import { runWriteTool } from '../write-tx.js';

export const TOOL_NAME = 'recon_import_invoices';

const NAME_MAX = 128;
/** Byte-accurate cap on the resolved CSV text (contract: inline content ≤ 1 MB). */
const MAX_CONTENT_BYTES = 1_000_000;

export async function reconImportInvoices(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<ReconImportInvoicesOutput>> {
  const parsed = reconImportInvoicesInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  // Resolve the CSV text. Exactly one of content/file_path is guaranteed by the schema.
  let content: string;
  if (input.content !== undefined) {
    // Inline content ≤ 1 MB (contract §6.4), byte-accurate: the schema's char-length
    // check is a cheap pre-filter a multibyte payload can still slip past.
    if (Buffer.byteLength(input.content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new ToolError('INVALID_INPUT', 'inline content exceeds the 1 MB limit');
    }
    content = input.content;
  } else {
    // file_path reads are confined to RECONCIL_IMPORT_DIR and size-capped (import-fs).
    content = await readImportFile(input.file_path!);
  }

  const parseOpts: ParseOptions = {};
  if (input.mapping !== undefined) parseOpts.mapping = input.mapping;
  if (input.defaults !== undefined) {
    parseOpts.defaults = {
      ...(input.defaults.currency !== undefined ? { currency: input.defaults.currency } : {}),
      ...(input.defaults.direction !== undefined ? { direction: input.defaults.direction } : {}),
      // vat_rate is a rate (number on the wire); carry it as a decimal string internally.
      ...(input.defaults.vat_rate !== undefined ? { vatRate: String(input.defaults.vat_rate) } : {}),
    };
  }

  // Resolve client_id to the tenant's own before any write (ADR-006); a bad/foreign id
  // is INVALID_INPUT, never a raw uuid-cast error. Mirrors ledger_track_wallet.
  const clientId = await resolveClientId(ctx, input.client_id);

  const { drafts, errors } = parseInvoiceCsv(content, parseOpts);

  // The bulky CSV `content` is redacted from the audit args — the raw rows live in each
  // external_records.payload, so args only records the call shape.
  const persistedArgs: Record<string, unknown> = { ...input };
  if (input.content !== undefined) persistedArgs.content = `<${String(input.content.length)} chars omitted>`;

  // The insert and the tool_call audit row commit in one transaction (C2): a failure here
  // — including the output-contract check below — rolls the import back rather than leaving
  // it un-audited.
  return runWriteTool<ReconImportInvoicesOutput>(ctx, {
    toolName: TOOL_NAME,
    args: persistedArgs,
    body: async (txCtx) => {
      const { inserted, skippedDuplicates } = await importExternalRecords(txCtx, drafts, clientId);

      const warnings: Warning[] = [];
      let heavy = false;
      const records: ReconImportedRecordView[] = inserted.map((r) => {
        const view: ReconImportedRecordView = { id: r.id, external_ref: r.externalRef, amount: r.amount, currency: r.currency };
        if (r.issuedOn !== null) view.issued_on = r.issuedOn;
        if (r.counterpartyName !== null) {
          const s = sanitize(r.counterpartyName, { maxLength: NAME_MAX });
          if (s.heavy) heavy = true;
          view.untrusted = { counterparty_name: s.display };
        }
        return view;
      });
      if (heavy) warnings.push({ code: 'SANITIZED_HEAVY', message: 'one or more counterparty names were heavily sanitized' });

      const data: ReconImportInvoicesOutput = {
        inserted: inserted.length,
        skipped_duplicates: skippedDuplicates,
        errors,
        records,
      };

      try {
        reconImportInvoicesOutput.parse(data);
      } catch (err) {
        throw new ToolError('INTERNAL', 'recon_import_invoices produced an output that violates its contract', undefined, err);
      }

      return { data, envelope: { coverage: [], warnings } };
    },
  });
}
