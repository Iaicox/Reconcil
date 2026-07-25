/**
 * `recon_import_invoices` (contract §6.4, write, idempotent) — import invoices from
 * CSV into `external_records`. The parse is pure (@reconcil/recon); this handler owns
 * the I/O edges: resolving `content` vs `file_path`, sanitizing hostile counterparty
 * names for the response (raw stays server-side, only the scrubbed value ships under
 * `untrusted`, C6/ADR-011), and persisting the tool_call before responding (C2).
 * Row-level problems are returned in `errors[]`, not thrown — a partial import is a
 * normal outcome.
 */
import { readFile } from 'node:fs/promises';

import {
  reconImportInvoicesInput, reconImportInvoicesOutput, sanitize,
  type ReconImportInvoicesOutput, type ReconImportedRecordView, type Warning,
} from '@reconcil/core';
import { parseInvoiceCsv, type ParseOptions } from '@reconcil/recon';

import type { ToolContext } from '../context.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { importExternalRecords } from '../recon/repo.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'recon_import_invoices';

const NAME_MAX = 128;

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
    content = input.content;
  } else {
    try {
      content = await readFile(input.file_path!, 'utf8');
    } catch (err) {
      throw new ToolError('INVALID_INPUT', `could not read file_path: ${String(err)}`);
    }
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

  const { drafts, errors } = parseInvoiceCsv(content, parseOpts);
  const { inserted, skippedDuplicates } = await importExternalRecords(ctx, drafts, input.client_id ?? null);

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
    throw new ToolError('INTERNAL', `recon_import_invoices produced an output that violates its contract: ${String(err)}`);
  }

  // Persist the call for audit (C2). The bulky CSV `content` is redacted — the raw
  // rows live in each external_records.payload, so args only records the call shape.
  const persistedArgs: Record<string, unknown> = { ...input };
  if (input.content !== undefined) persistedArgs.content = `<${String(input.content.length)} chars omitted>`;
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: persistedArgs, coverage: [], result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: [], warnings });
}
