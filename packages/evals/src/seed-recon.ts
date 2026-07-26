/**
 * Recon eval fixture seeding (04-testing.md §5). The Face B eval cases (import → suggest →
 * confirm → status → journal) run the agent against a fixed reconciliation scenario; this
 * builds it directly in the DB, the recon sibling of `seed.ts`'s golden-wallet path. One
 * rich `recon-smb` scenario supports every Face B case: confirmed legs (for status/journal),
 * a partial (for the partial-payment explanation), a VAT invoice (for the journal split),
 * and two legless-but-settled records (for suggest/confirm). Deterministic addresses, tx
 * hashes and block times so a re-seed is byte-identical.
 *
 * The stablecoin is EURC (verified, `is_stablecoin`, 6 decimals) so the matcher's candidate
 * gate accepts the settlements at face value (P5, same valuation as B2/B4); the confirmed
 * legs carry that face value as `fiat_value`, price/fx refs left NULL. Amounts are EUR minor
 * units (× 10⁶) as `bigint` — money never rides as `number` (ADR-004).
 */
import {
  chainEvents,
  clients,
  externalRecords,
  matches,
  tokens,
  wallets,
  type Db,
} from '@reconcil/db';

export type ReconFixtureRole = 'recon-smb';

const WALLET = `0x${'1'.repeat(40)}`;
const PAYER = `0x${'2'.repeat(40)}`;
const VENDOR = `0x${'9'.repeat(40)}`;
const EURC = `0x${'c'.repeat(40)}`;

/** EUR whole units → EURC base units (6 decimals). */
const minor = (whole: number): bigint => BigInt(Math.round(whole * 1_000_000));

export interface SeededReconFixture {
  clientId: string;
  walletAddress: string;
  tokenId: number;
  /** external_records ids, keyed by external_ref. */
  records: Record<'INV-PAID' | 'INV-VAT' | 'INV-PARTIAL' | 'INV-OPEN' | 'BILL-OPEN', string>;
}

/**
 * Seed the `recon-smb` reconciliation scenario for one tenant and return the handles the
 * eval harness / itests need. Precondition: the tenant row already exists; call once per
 * (freshly truncated) tenant.
 */
export async function seedReconFixture(
  db: Db,
  tenantId: string,
  role: ReconFixtureRole = 'recon-smb',
): Promise<SeededReconFixture> {
  if (role !== 'recon-smb') throw new Error(`unknown recon fixture role "${role}"`);

  const [client] = await db
    .insert(clients)
    .values({ tenantId, name: 'Acme Client', baseCurrency: 'EUR' })
    .returning({ id: clients.id });
  const clientId = client!.id;

  await db.insert(wallets).values({ tenantId, clientId, address: WALLET });

  const [token] = await db
    .insert(tokens)
    .values({
      chainId: 1,
      address: EURC,
      standard: 'erc20',
      symbolDisplay: 'EURC',
      decimals: 6,
      isStablecoin: true,
      pegCurrency: 'EUR',
      verified: true,
    })
    .returning({ id: tokens.id });
  const tokenId = token!.id;

  /** An inbound (to the wallet) or outbound (from the wallet) EURC settlement. */
  async function settle(
    seg: string,
    whole: number,
    dir: 'in' | 'out',
    block: number,
    day: number,
  ): Promise<number> {
    const from = dir === 'in' ? PAYER : WALLET;
    const to = dir === 'in' ? WALLET : VENDOR;
    const [ev] = await db
      .insert(chainEvents)
      .values({
        chainId: 1,
        txHash: `0x${seg.repeat(32)}`,
        logIndex: 0,
        eventKind: 'erc20_transfer',
        tokenId,
        amountRaw: minor(whole),
        fromAddr: from,
        toAddr: to,
        blockNumber: block,
        blockTime: new Date(`2026-06-${String(day).padStart(2, '0')}T10:00:00.000Z`),
        txFrom: from,
        txTo: to,
        provider: 'synthetic-recon',
        raw: {},
      })
      .returning({ id: chainEvents.id });
    return ev!.id;
  }

  async function record(
    externalRef: string,
    amount: number,
    opts: {
      direction?: 'receivable' | 'payable';
      vatRate?: number | null;
      counterparty: string;
      status: 'open' | 'partially_matched' | 'matched';
    },
  ): Promise<string> {
    const { direction = 'receivable', vatRate = null, counterparty, status } = opts;
    const [rec] = await db
      .insert(externalRecords)
      .values({
        tenantId,
        clientId,
        kind: 'invoice',
        direction,
        source: 'csv',
        externalRef,
        counterpartyName: counterparty,
        amount: amount.toFixed(2),
        currency: 'EUR',
        vatRate: vatRate === null ? null : vatRate.toFixed(2),
        issuedOn: '2026-06-01',
        status,
      })
      .returning({ id: externalRecords.id });
    return rec!.id;
  }

  /** A confirmed leg pinning the settlement's face value (P5); price/fx refs stay NULL. */
  async function confirm(recordId: string, eventId: number, whole: number): Promise<void> {
    await db.insert(matches).values({
      tenantId,
      externalRecordId: recordId,
      chainEventId: eventId,
      amountAppliedRaw: minor(whole),
      fiatValue: whole.toFixed(2),
      fiatCurrency: 'EUR',
      status: 'confirmed',
      matchedBy: 'agent',
      confirmedBy: 'agent',
      confirmedAt: new Date('2026-06-30T00:00:00.000Z'),
      confidence: '0.95',
      rationale: {},
    });
  }

  // Confirmed settlements: a plain receivable, a VAT receivable, and a partial.
  const paid = await record('INV-PAID', 1000, { counterparty: 'ACME GmbH', status: 'matched' });
  const evPaid = await settle('a1', 1000, 'in', 100, 10);
  await confirm(paid, evPaid, 1000);

  const vat = await record('INV-VAT', 1210, { vatRate: 21, counterparty: 'ACME GmbH', status: 'matched' });
  const evVat = await settle('a2', 1210, 'in', 101, 11);
  await confirm(vat, evVat, 1210);

  const partial = await record('INV-PARTIAL', 1000, { counterparty: 'Beta Ltd', status: 'partially_matched' });
  const evPartial = await settle('a3', 400, 'in', 102, 12);
  await confirm(partial, evPartial, 400);

  // Legless-but-settled records: an open receivable + an open payable → suggest/confirm.
  const open = await record('INV-OPEN', 300, { counterparty: 'Gamma SA', status: 'open' });
  await settle('a4', 300, 'in', 103, 13);

  const bill = await record('BILL-OPEN', 500, { direction: 'payable', counterparty: 'Cloud Vendor', status: 'open' });
  await settle('a5', 500, 'out', 104, 14);

  return {
    clientId,
    walletAddress: WALLET,
    tokenId,
    records: {
      'INV-PAID': paid,
      'INV-VAT': vat,
      'INV-PARTIAL': partial,
      'INV-OPEN': open,
      'BILL-OPEN': bill,
    },
  };
}
