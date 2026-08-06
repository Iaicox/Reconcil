/**
 * `export_journal_drafts` renderer (contract §6.5): confirmed settlements → a
 * QBO/Xero manual-journal CSV draft. Pure and deterministic. This is the ONLY
 * rounding site (ADR-004): the confirmed leg's stored `fiat_value` (full precision,
 * face value pinned at confirm, P5) is rounded to 2dp here, then split net/VAT.
 *
 * Double-entry per settlement (V = 2dp gross; r = VAT %). With `r > 0` the control
 * line is split so VAT is recognized at settlement date; `net = V×100/(100+r)`,
 * `vat = V − net` (so `net + vat == V` — every entry is internally balanced):
 *   - receivable:  Dr crypto_asset V / Cr accounts_receivable net / Cr vat_output vat
 *   - payable:     Cr crypto_asset V / Dr accounts_payable   net / Dr vat_input  vat
 * Multi-currency exports are one file, balanced independently per currency — by
 * construction, never via a `rounding` correction line; a currency whose debits and
 * credits diverge fails the render (invariant violation, see below). Every artifact
 * is a DRAFT (P8): a banner row + a `_DRAFT` filename. Hostile import strings
 * (`externalRef`, counterparty) are sanitized before they reach a cell (P7/C6), and
 * `toCsv` neutralizes spreadsheet formula injection (CWE-1236) as the second layer.
 */
import { sanitize } from '@reconcil/core';

import { toCsv, type CsvValue } from './csv.js';
import { isNegative, isZero, netOfVat, roundHalfUp, subtract, sumDecimals } from './decimal.js';
import { periodSlug } from './period.js';
import { sha256 } from './sha256.js';
import type {
  JournalCategory, JournalDraftsInput, JournalDraftsResult, JournalManifest, RoundingResidue,
} from './types.js';

const DEFAULT_ACCOUNTS: Record<JournalCategory, string> = {
  crypto_asset: 'Crypto Assets',
  accounts_receivable: 'Accounts Receivable',
  accounts_payable: 'Accounts Payable',
  vat_output: 'VAT Output',
  vat_input: 'VAT Input',
};

const QBO_HEADER = ['*JournalNo', '*JournalDate', '*AccountName', 'Debits', 'Credits', 'Description', 'Currency'];
const XERO_HEADER = ['*Narration', '*Date', '*AccountCode', '*Description', 'Debit', 'Credit', 'Currency'];
const BANNER = 'DRAFT — REVIEW REQUIRED';
const ZERO = '0.00';

interface TaggedLine {
  journalNo: string;
  date: string;
  category: JournalCategory;
  description: string; // already sanitized
  debit: string; // 2dp, '0.00' when a credit line
  credit: string; // 2dp, '0.00' when a debit line
  currency: string;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function line(
  journalNo: string, date: string, category: JournalCategory, description: string,
  side: 'debit' | 'credit', amount: string, currency: string,
): TaggedLine {
  return {
    journalNo, date, category, description,
    debit: side === 'debit' ? amount : ZERO,
    credit: side === 'credit' ? amount : ZERO,
    currency,
  };
}

/** Sanitized `<ref> — <counterparty>` (counterparty omitted when blank). */
function describe(externalRef: string, counterparty: string): string {
  const ref = sanitize(externalRef).display;
  if (counterparty.trim() === '') return ref;
  return `${ref} — ${sanitize(counterparty).display}`;
}

/**
 * Build the double-entry lines for one confirmed settlement (empty if zero-valued).
 *
 * A negative `V` (after rounding) throws rather than emitting a negative debit/credit:
 * `matches.fiat_value` and the confirm path are non-negative today, so this is an
 * assertion on an invariant the pipeline cannot violate, not a behavior change. Credit
 * notes/reversals are not modelled yet; when they are, they must flip the entry's
 * sides, not emit a negative amount.
 */
function entryLines(entry: JournalDraftsInput['entries'][number], journalNo: string): TaggedLine[] {
  const V = roundHalfUp(entry.grossFiat, 2);
  if (isZero(V)) return [];
  if (isNegative(V)) {
    throw new Error(
      `journal-drafts: entry ${entry.externalRef} (${entry.direction}, ${entry.currency}) has a negative gross ${V}; credit notes/reversals are not modelled yet — they must flip the entry's sides, not emit a negative amount`,
    );
  }
  const desc = describe(entry.externalRef, entry.counterparty);
  const { date, currency, direction } = entry;
  const control: JournalCategory = direction === 'receivable' ? 'accounts_receivable' : 'accounts_payable';
  const vatCat: JournalCategory = direction === 'receivable' ? 'vat_output' : 'vat_input';
  // The control + VAT side is a credit for a receivable (we cleared what was owed to
  // us / recognized output VAT) and a debit for a payable; the asset side mirrors it.
  const controlSide: 'debit' | 'credit' = direction === 'receivable' ? 'credit' : 'debit';
  const assetSide: 'debit' | 'credit' = direction === 'receivable' ? 'debit' : 'credit';

  const lines = [line(journalNo, date, 'crypto_asset', desc, assetSide, V, currency)];
  if (entry.vatRate !== null && entry.vatRate > 0) {
    const net = netOfVat(V, entry.vatRate);
    const vat = roundHalfUp(subtract(V, net), 2); // exact (both 2dp), formatted to 2dp
    lines.push(line(journalNo, date, control, desc, controlSide, net, currency));
    if (!isZero(vat)) lines.push(line(journalNo, date, vatCat, desc, controlSide, vat, currency));
  } else {
    lines.push(line(journalNo, date, control, desc, controlSide, V, currency));
  }
  return lines;
}

export function renderJournalDrafts(input: JournalDraftsInput): JournalDraftsResult {
  const { target, scope, provenance } = input;
  const mapping = input.accountMapping ?? {};

  // Deterministic entry order → stable journal numbers → byte-stable output.
  const sorted = [...input.entries].sort(
    (a, b) =>
      cmp(a.currency, b.currency) || cmp(a.date, b.date) ||
      cmp(a.externalRef, b.externalRef) || cmp(a.direction, b.direction),
  );
  // Journal numbers are contiguous over the ENTRIES that produce lines: a zero-valued
  // entry emits nothing and must not consume a number (else 1,3,4…).
  let journalNo = 0;
  const built = sorted.flatMap((e) => {
    const lines = entryLines(e, String(journalNo + 1));
    if (lines.length > 0) journalNo += 1;
    return lines;
  });

  // Order lines by currency and assert each currency balances. Under face-value valuation
  // every entry is internally balanced (Dr V == Cr net+vat), so the per-currency sum is
  // exact and the residue is always 0.00 — the file is balanced BY CONSTRUCTION, not by a
  // correction line. A non-zero residue would mean a confirmed-leg entry failed to balance
  // internally: an invariant violation, NOT something to paper over with a standalone
  // rounding line (which, being single-sided, is itself an unbalanced journal that QBO/Xero
  // reject on import). If a future volatile-token valuation ever breaks per-entry balance it
  // must fold the correction into that entry's own journal before this point — see the
  // non-stablecoin-valuation slice.
  const currencies = [...new Set(built.map((l) => l.currency))].sort();
  const roundingResidues: RoundingResidue[] = [];
  const ordered: TaggedLine[] = [];
  for (const currency of currencies) {
    const group = built.filter((l) => l.currency === currency);
    const residue = roundHalfUp(
      subtract(sumDecimals(group.map((l) => l.debit)), sumDecimals(group.map((l) => l.credit))),
      2,
    );
    if (!isZero(residue)) {
      throw new Error(
        `journal-drafts: ${currency} debits and credits diverge by ${residue}; a confirmed-leg entry did not balance internally (invariant violation)`,
      );
    }
    ordered.push(...group);
    roundingResidues.push({ currency, residue });
  }

  // Resolve accounts, tracking which present categories the mapping did not cover.
  const unmapped = new Set<JournalCategory>();
  const accountFor = (category: JournalCategory): string => {
    const code = mapping[category];
    if (code !== undefined && code !== '') return code;
    unmapped.add(category);
    return DEFAULT_ACCOUNTS[category];
  };

  const header = target === 'qbo' ? QBO_HEADER : XERO_HEADER;
  const banner: CsvValue[] = [BANNER, '', '', '', '', '', ''];
  const body: CsvValue[][] = [
    banner,
    ...ordered.map((l) => {
      const account = accountFor(l.category);
      // QBO groups a journal by explicit *JournalNo; Xero groups by narration, so the
      // journal number rides the narration (`#N …`) — otherwise two distinct legs sharing a
      // ref+counterparty+date would merge into one Xero journal while staying separate in QBO.
      return target === 'qbo'
        ? [l.journalNo, l.date, account, l.debit, l.credit, l.description, l.currency]
        : [`#${l.journalNo} ${l.description}`, l.date, account, l.description, l.debit, l.credit, l.currency];
    }),
  ];

  const content = toCsv(header, body);
  // Identifying, byte-stable name (see period.ts for the scheme): a pure function of
  // `target` + `input.period`, so two different periods never collide in one folder.
  const name = `journal_draft_${target}_${periodSlug(input.period)}_DRAFT.csv`;
  const fileSha = sha256(content);
  const unmappedCategories = [...unmapped].sort();

  const manifest: JournalManifest = {
    schema_version: 1,
    export_id: provenance.exportId,
    tool_call_id: provenance.toolCallId,
    kind: target === 'qbo' ? 'journal_qbo' : 'journal_xero',
    target,
    period: input.period,
    scope: {
      addresses: scope.addresses,
      ...(scope.clientId != null ? { client_id: scope.clientId } : {}),
    },
    generated_at: provenance.generatedAt,
    draft: true,
    coverage: provenance.coverage,
    price_refs: provenance.priceRefs,
    fx_refs: provenance.fxRefs,
    rounding_residues: roundingResidues,
    account_mapping: mapping,
    unmapped_categories: unmappedCategories,
    lines: ordered.length,
    file: { name, sha256: fileSha },
  };

  return {
    file: { name, content, sha256: fileSha },
    lines: ordered.length,
    unmappedCategories,
    roundingResidues,
    manifest,
  };
}
