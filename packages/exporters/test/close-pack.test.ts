import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { renderClosePack, type ClosePackInput, type Manifest, type RenderedFile } from '../src/index.js';

const ETH = { chainId: 1, address: null, symbol: 'ETH', decimals: 18, isStablecoin: false };

function fixture(): ClosePackInput {
  return {
    period: { start: '2026-06-01', end: '2026-06-30' },
    currency: 'USD',
    scope: { addresses: ['0xaaa'], clientId: null },
    balancesOpening: [{ address: '0xaaa', chainId: 1, token: ETH, amount: '10', fiatValue: '20000' }],
    balancesClosing: [{ address: '0xaaa', chainId: 1, token: ETH, amount: '6', fiatValue: '12000' }],
    transactions: [
      { chainId: 1, txHash: '0xtx1', logIndex: -1, blockTime: '2026-06-10T12:00:00.000Z', kind: 'native_transfer', token: ETH, amount: '3', direction: 'out', from: '0xaaa', to: '0xext' },
    ],
    gas: [{ chainId: 1, nativeSymbol: 'ETH', nativeAmount: '1', txCount: 2, fiatValue: '2000' }],
    counterparties: [
      { counterparty: '0xext', labeled: false, tokenSymbol: 'ETH', inflow: '0', outflow: '3', fiatInflow: '0', fiatOutflow: '6000', txCount: 1 },
    ],
    journal: { movements: [{ tokenSymbol: 'ETH', netFiat: '-6000' }], gasFiat: '2000' },
    provenance: {
      exportId: 'test-export-id',
      toolCallId: 'test-tool-call',
      generatedAt: '2026-07-01T00:00:00.000Z',
      coverage: [],
      priceRefs: [{ snapshot_id: 1, token: 'ETH', date: '2026-06-30', currency: 'USD', source: 'defillama', price: '2000' }],
      fxRefs: [],
    },
  };
}

function byName(files: RenderedFile[]): Map<string, RenderedFile> {
  return new Map(files.map((f) => [f.name, f]));
}

function text(f: RenderedFile | undefined): string {
  if (f === undefined || typeof f.content !== 'string') throw new Error('expected a text file');
  return f.content;
}

describe('renderClosePack — the 7-file close bundle', () => {
  it('emits exactly the 7 contract files in a fixed order', () => {
    const out = renderClosePack(fixture());
    expect(out.files.map((f) => f.name)).toEqual([
      'balances_opening.csv',
      'balances_closing.csv',
      'transactions.csv',
      'gas.csv',
      'counterparty_summary.csv',
      'journal_draft.csv',
      'manifest.json',
    ]);
  });

  it('serializes gas and transactions CSVs byte-for-byte', () => {
    const files = byName(renderClosePack(fixture()).files);
    expect(text(files.get('gas.csv'))).toBe(
      'chain_id,native_symbol,native_amount,tx_count,fiat_value,currency\n1,ETH,1,2,2000,USD\n',
    );
    expect(text(files.get('transactions.csv'))).toBe(
      'chain_id,tx_hash,log_index,block_time,kind,token_symbol,amount,direction,from,to\n' +
        '1,0xtx1,-1,2026-06-10T12:00:00.000Z,native_transfer,ETH,3,out,0xaaa,0xext\n',
    );
  });

  it('renders the expected balanced journal — amounts, signs, no gas double-count (invariant #8)', () => {
    const files = byName(renderClosePack(fixture()).files);
    const journal = text(files.get('journal_draft.csv'));
    expect(journal).toContain('DRAFT — REVIEW REQUIRED');

    // [date, account, description, debit, credit, currency] — no field here contains a comma.
    const rows = journal.trimEnd().split('\n').slice(2).map((r) => r.split(',')); // drop header + banner
    const line = (account: string, description: string): string[] | undefined =>
      rows.find((r) => r[1] === account && r[2] === description);

    // Net ETH movement was -6000 (outflow) → assets DOWN (credit), Suspense debit — sign correct.
    expect(line('Crypto Assets', 'Net ETH movement (DRAFT)')).toEqual(
      ['2026-06-30', 'Crypto Assets', 'Net ETH movement (DRAFT)', '0.00', '6000.00', 'USD'],
    );
    expect(line('Suspense — unclassified', 'Net ETH movement (DRAFT)')?.[3]).toBe('6000.00');
    // Gas 2000 appears exactly once (one expense debit + one asset credit) — not double-counted.
    expect(line('Network Fees (gas)', 'Gas fees (DRAFT)')?.[3]).toBe('2000.00');
    expect(rows.filter((r) => r[1] === 'Network Fees (gas)')).toHaveLength(1);

    const debit = rows.reduce((a, r) => a.plus(r[3] ?? '0'), new Decimal(0));
    const credit = rows.reduce((a, r) => a.plus(r[4] ?? '0'), new Decimal(0));
    expect(debit.toFixed(2)).toBe('8000.00');
    expect(credit.toFixed(2)).toBe('8000.00');
  });

  it('builds a manifest citing every file hash, marked draft, with a zero residue', () => {
    const out = renderClosePack(fixture());
    const files = byName(out.files);
    const manifest = JSON.parse(text(files.get('manifest.json'))) as Manifest;

    expect(manifest.schema_version).toBe(1);
    expect(manifest.kind).toBe('close_pack');
    expect(manifest.export_id).toBe('test-export-id');
    expect(manifest.tool_call_id).toBe('test-tool-call');
    expect(manifest.draft).toBe(true);
    expect(manifest.generated_at).toBe('2026-07-01T00:00:00.000Z');
    expect(manifest.rounding_residues).toEqual([{ currency: 'USD', residue: '0.00' }]);
    expect(manifest.price_refs).toHaveLength(1);

    // manifest.files lists the 6 CSVs, each hash matching the rendered file
    expect(manifest.files.map((f) => f.name)).toEqual([
      'balances_opening.csv', 'balances_closing.csv', 'transactions.csv',
      'gas.csv', 'counterparty_summary.csv', 'journal_draft.csv',
    ]);
    for (const mf of manifest.files) {
      expect(mf.sha256).toBe(files.get(mf.name)?.sha256);
    }
  });

  it('is deterministic — identical bytes and hashes on repeat renders', () => {
    const a = byName(renderClosePack(fixture()).files);
    const b = byName(renderClosePack(fixture()).files);
    for (const [name, fa] of a) {
      expect(b.get(name)?.sha256).toBe(fa.sha256);
    }
  });
});
