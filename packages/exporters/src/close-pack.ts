/**
 * `export_close_pack` renderer (contract §6.5): six CSVs + a manifest, produced
 * as in-memory files (name + content + sha256). Pure and deterministic — given
 * the same input (including provenance ids and `generatedAt`) it emits byte-
 * identical bytes, which is what the golden tests pin. Row order is fixed by a
 * stable sort per file; money is presented as decimal strings (rounding for the
 * journal happens in `buildJournalDraft`, the only rounding site).
 */
import { toCsv, type CsvValue } from './csv.js';
import { buildManifest, serializeManifest } from './manifest.js';
import { buildJournalDraft, type JournalLine } from './journal.js';
import { sha256 } from './sha256.js';
import type {
  BalanceExportRow, ClosePackInput, CounterpartyExportRow, Currency, GasExportRow,
  RenderedExport, RenderedFile, RoundingResidue, TransactionExportRow,
} from './types.js';

const BALANCE_HEADER = ['address', 'chain_id', 'token_symbol', 'token_address', 'decimals', 'amount', 'fiat_value', 'currency'];
const TRANSACTION_HEADER = ['chain_id', 'tx_hash', 'log_index', 'block_time', 'kind', 'token_symbol', 'amount', 'direction', 'from', 'to'];
const GAS_HEADER = ['chain_id', 'native_symbol', 'native_amount', 'tx_count', 'fiat_value', 'currency'];
const COUNTERPARTY_HEADER = ['counterparty', 'labeled', 'token_symbol', 'inflow', 'outflow', 'fiat_inflow', 'fiat_outflow', 'tx_count', 'currency'];
const JOURNAL_HEADER = ['date', 'account', 'description', 'debit', 'credit', 'currency'];

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function balancesCsv(rows: BalanceExportRow[], currency: Currency): string {
  const sorted = [...rows].sort(
    (a, b) =>
      a.chainId - b.chainId ||
      cmp(a.token.address ?? '', b.token.address ?? '') ||
      cmp(a.address, b.address),
  );
  const body: CsvValue[][] = sorted.map((r) => [
    r.address,
    r.chainId,
    r.token.symbol,
    r.token.address ?? '',
    r.token.decimals,
    r.amount,
    r.fiatValue ?? '',
    currency,
  ]);
  return toCsv(BALANCE_HEADER, body);
}

function transactionsCsv(rows: TransactionExportRow[]): string {
  const sorted = [...rows].sort(
    (a, b) =>
      a.chainId - b.chainId ||
      cmp(a.blockTime, b.blockTime) ||
      cmp(a.txHash, b.txHash) ||
      a.logIndex - b.logIndex,
  );
  const body: CsvValue[][] = sorted.map((r) => [
    r.chainId,
    r.txHash,
    r.logIndex,
    r.blockTime,
    r.kind,
    r.token.symbol,
    r.amount,
    r.direction,
    r.from,
    r.to,
  ]);
  return toCsv(TRANSACTION_HEADER, body);
}

function gasCsv(rows: GasExportRow[], currency: Currency): string {
  const sorted = [...rows].sort((a, b) => a.chainId - b.chainId);
  const body: CsvValue[][] = sorted.map((r) => [
    r.chainId,
    r.nativeSymbol,
    r.nativeAmount,
    r.txCount,
    r.fiatValue ?? '',
    currency,
  ]);
  return toCsv(GAS_HEADER, body);
}

function counterpartiesCsv(rows: CounterpartyExportRow[], currency: Currency): string {
  const sorted = [...rows].sort(
    (a, b) => cmp(a.counterparty, b.counterparty) || cmp(a.tokenSymbol, b.tokenSymbol),
  );
  const body: CsvValue[][] = sorted.map((r) => [
    r.counterparty,
    r.labeled ? 'true' : 'false',
    r.tokenSymbol,
    r.inflow,
    r.outflow,
    r.fiatInflow ?? '',
    r.fiatOutflow ?? '',
    r.txCount,
    currency,
  ]);
  return toCsv(COUNTERPARTY_HEADER, body);
}

function journalCsv(lines: JournalLine[], currency: Currency): string {
  // A leading, valid-CSV banner row labels the whole artifact as a draft (P8),
  // then the journal lines in construction order (already deterministic).
  const banner: CsvValue[] = ['', 'DRAFT — REVIEW REQUIRED', 'Not a filed journal; generated pre-reconciliation (P8)', '', '', currency];
  const body: CsvValue[][] = [banner, ...lines.map((l) => [l.date, l.account, l.description, l.debit, l.credit, l.currency])];
  return toCsv(JOURNAL_HEADER, body);
}

export function renderClosePack(input: ClosePackInput): RenderedExport {
  const journal = buildJournalDraft(input.journal, input.currency, input.period.end);
  const roundingResidues: RoundingResidue[] = [{ currency: input.currency, residue: journal.residue }];

  const csvFiles = [
    { name: 'balances_opening.csv', content: balancesCsv(input.balancesOpening, input.currency) },
    { name: 'balances_closing.csv', content: balancesCsv(input.balancesClosing, input.currency) },
    { name: 'transactions.csv', content: transactionsCsv(input.transactions) },
    { name: 'gas.csv', content: gasCsv(input.gas, input.currency) },
    { name: 'counterparty_summary.csv', content: counterpartiesCsv(input.counterparties, input.currency) },
    { name: 'journal_draft.csv', content: journalCsv(journal.lines, input.currency) },
  ];
  const hashed: RenderedFile[] = csvFiles.map((f) => ({ ...f, sha256: sha256(f.content) }));

  const manifest = buildManifest({
    kind: 'close_pack',
    period: input.period,
    currency: input.currency,
    scope: input.scope,
    provenance: input.provenance,
    files: hashed.map((f) => ({ name: f.name, sha256: f.sha256 })),
    roundingResidues,
  });
  const manifestContent = serializeManifest(manifest);

  const files: RenderedFile[] = [
    ...hashed,
    { name: 'manifest.json', content: manifestContent, sha256: sha256(manifestContent) },
  ];
  return { files, manifest, roundingResidues };
}
