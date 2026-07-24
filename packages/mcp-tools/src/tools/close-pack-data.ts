/**
 * Shared compute for the Face A export tools (contract §6.5). Resolves scope +
 * month → period, then composes ledger (balances at open/close, transactions,
 * gas, counterparties, per-token flows) with pricing (`valueQuantities`) — the
 * SAME deterministic calls the analytics_* tools use — and maps the results into
 * the pure `@pet-crypto/exporters` render shapes. Rounding is NOT done here; it
 * happens once, in exporters, at the export boundary (ADR-004). Both
 * `export_close_pack` and `export_pdf_summary` call this so the PDF and the CSV
 * bundle describe exactly the same figures.
 */
import type { CoverageRef, FxRef, PriceRef, Scope, Valuation, Warning } from '@pet-crypto/core';
import { compareDecimals } from '@pet-crypto/exporters';
import type {
  BalanceExportRow, CounterpartyExportRow, ExportPeriod, ExportScope, GasExportRow,
  JournalInput, JournalMovement, TokenLabel, TransactionExportRow,
} from '@pet-crypto/exporters';
import {
  computeBalances, computeCounterparties, computeFlows, computeGas, getLedgerStatus, listEvents,
  type BackingEvents, type BalanceRow, type EventListItem, type GasRow, type TokenMeta,
} from '@pet-crypto/ledger';
import { sumDecimals, valueQuantities, type ValuationResult, type ValueNeed } from '@pet-crypto/pricing';

import type { ToolContext } from '../context.js';
import { mapCoverage } from '../coverage.js';
import type { EnvelopeParts } from '../envelope.js';
import { collectPricingRefs, toWireValuation } from '../pricing-refs.js';
import { lastDayOfMonth } from '../rep-date.js';
import { resolveClientId, resolveScope } from '../scope.js';
import { selectRefs } from '../refs.js';

export interface CloseDataInput {
  month: string; // YYYY-MM
  scope?: Scope;
  clientId?: string;
  valuation: Valuation; // the wire (core) shape; converted to pricing's via toWireValuation
}

export interface CloseData {
  period: ExportPeriod;
  currency: 'USD' | 'EUR';
  scope: ExportScope;
  // close-pack CSV shapes
  balancesOpening: BalanceExportRow[];
  balancesClosing: BalanceExportRow[];
  transactions: TransactionExportRow[];
  gas: GasExportRow[];
  counterparties: CounterpartyExportRow[];
  journal: JournalInput;
  // PDF headline figures (rounded for display in exporters)
  openingTotalFiat?: string;
  closingTotalFiat?: string;
  netFlowsFiat?: string;
  gasTotalFiat?: string;
  topCounterparties: { name: string; fiatTurnover: string }[];
  // envelope citations
  coverageRefs: CoverageRef[];
  priceRefs: PriceRef[];
  fxRefs: FxRef[];
  warnings: Warning[];
  refsParts: Pick<EnvelopeParts, 'eventRefs' | 'eventRefSummary'>;
}

function previousDayIso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function tokenLabel(t: TokenMeta): TokenLabel {
  return {
    chainId: t.chainId,
    address: t.address,
    symbol: t.symbolDisplay ?? '',
    decimals: t.decimals,
    isStablecoin: t.isStablecoin,
  };
}

function needFor(t: TokenMeta, date: string, amount: string): ValueNeed {
  return {
    tokenId: t.tokenId,
    date,
    amount: amount as ValueNeed['amount'],
    isStablecoin: t.isStablecoin,
    pegCurrency: t.pegCurrency,
    symbol: t.symbolDisplay,
  };
}

/** Sum the defined fiat values; `undefined` when nothing in scope was priced. */
function totalFiat(values: (string | undefined)[]): string | undefined {
  const defined = values.filter((v): v is string => v !== undefined);
  return defined.length > 0 ? sumDecimals(defined) : undefined;
}

export async function computeCloseData(ctx: ToolContext, input: CloseDataInput): Promise<CloseData> {
  const start = `${input.month}-01`;
  const end = lastDayOfMonth(input.month);
  const openingAsOf = previousDayIso(start);
  const period: ExportPeriod = { start, end };
  const ledgerPeriod = { from: start, to: end };
  const currency = input.valuation.currency;
  // toWireValuation returns pricing's strict Valuation (no `policy: undefined` key).
  const wireValuation = toWireValuation(input.valuation);

  const { addresses } = await resolveScope(ctx, input.scope);
  const clientId = await resolveClientId(ctx, input.clientId);
  const scope: ExportScope = { addresses, clientId };

  // Merge pricing citation refs + warnings across every valuation pass (dedup'd).
  const priceRefMap = new Map<number, PriceRef>();
  const fxRefMap = new Map<number, FxRef>();
  const pricingWarnings: Warning[] = [];
  const warnedKeys = new Set<string>();
  const merge = (valued: ValuationResult): (string | undefined)[] => {
    const c = collectPricingRefs(valued);
    for (const p of c.priceRefs) priceRefMap.set(p.snapshot_id, p);
    for (const f of c.fxRefs) fxRefMap.set(f.fx_rate_id, f);
    for (const w of c.warnings) {
      const k = `${w.code}|${w.message}`;
      if (!warnedKeys.has(k)) { warnedKeys.add(k); pricingWarnings.push(w); }
    }
    return valued.values.map((v) => v.fiatValue);
  };

  // --- balances at open (day before the month) and close (last day) ---------
  const [openingBal, closingBal, coverage] = await Promise.all([
    computeBalances(ctx.db, { scope: { addresses }, asOf: openingAsOf, includeUnverified: false }),
    computeBalances(ctx.db, { scope: { addresses }, asOf: end, includeUnverified: false }),
    getLedgerStatus(ctx.db, { addresses }),
  ]);

  const openingFiat = merge(
    await valueQuantities(ctx.db, openingBal.rows.map((r) => needFor(r.token, openingAsOf, r.amount)), wireValuation),
  );
  const closingFiat = merge(
    await valueQuantities(ctx.db, closingBal.rows.map((r) => needFor(r.token, end, r.amount)), wireValuation),
  );
  const balancesOpening = openingBal.rows.map((r, i) => balanceExport(r, openingFiat[i]));
  const balancesClosing = closingBal.rows.map((r, i) => balanceExport(r, closingFiat[i]));

  // --- transactions (all events in the month, paginated) --------------------
  const { events, truncated: eventsTruncated } = await listAllEvents(ctx, { scope: { addresses }, period: ledgerPeriod });
  const transactions = events.map(transactionExport);

  // --- gas (per chain), valued ----------------------------------------------
  const gasRows = await computeGas(ctx.db, { scope: { addresses }, period: ledgerPeriod, groupBy: ['chain'] });
  const gasFiat = merge(
    await valueQuantities(ctx.db, gasRows.map((r) => needFor(r.token, end, r.nativeAmount)), wireValuation),
  );
  const gas: GasExportRow[] = gasRows.map((r, i) => gasExport(r, gasFiat[i]));
  const gasTotalFiat = totalFiat(gasFiat);

  // --- per-token net flows → journal draft ----------------------------------
  const flows = await computeFlows(ctx.db, { scope: { addresses }, period: ledgerPeriod, includeUnverified: false });
  const flowFiat = merge(
    await valueQuantities(ctx.db, flows.rows.map((r) => needFor(r.token, end, r.net)), wireValuation),
  );
  const movements: JournalMovement[] = [];
  flows.rows.forEach((r, i) => {
    const netFiat = flowFiat[i];
    if (netFiat !== undefined) movements.push({ tokenSymbol: r.token.symbolDisplay ?? '', netFiat });
  });
  const journal: JournalInput = { movements, ...(gasTotalFiat !== undefined ? { gasFiat: gasTotalFiat } : {}) };
  const netFlowsFiat = totalFiat(movements.map((m) => m.netFiat));

  // --- counterparties (turnover per counterparty, per token), valued --------
  const cpResult = await computeCounterparties(ctx.db, { scope: { addresses }, period: ledgerPeriod, topN: 500, includeUnverified: false });
  const counterparties: CounterpartyExportRow[] = [];
  const cpNeeds: ValueNeed[] = []; // [inflow, outflow] interleaved per flat row
  for (const row of cpResult.rows) {
    for (const t of row.perToken) {
      counterparties.push({
        counterparty: row.address,
        labeled: false,
        tokenSymbol: t.token.symbolDisplay ?? '',
        inflow: t.inflow,
        outflow: t.outflow,
        txCount: row.txCount,
      });
      cpNeeds.push(needFor(t.token, end, t.inflow), needFor(t.token, end, t.outflow));
    }
  }
  const cpFiat = merge(await valueQuantities(ctx.db, cpNeeds, wireValuation));
  const turnoverByCounterparty = new Map<string, string[]>();
  counterparties.forEach((row, i) => {
    const inflow = cpFiat[i * 2];
    const outflow = cpFiat[i * 2 + 1];
    if (inflow !== undefined) row.fiatInflow = inflow;
    if (outflow !== undefined) row.fiatOutflow = outflow;
    const bucket = turnoverByCounterparty.get(row.counterparty) ?? [];
    if (inflow !== undefined) bucket.push(inflow);
    if (outflow !== undefined) bucket.push(outflow);
    turnoverByCounterparty.set(row.counterparty, bucket);
  });
  const topCounterparties = [...turnoverByCounterparty.entries()]
    .map(([name, parts]) => ({ name, fiatTurnover: parts.length > 0 ? sumDecimals(parts) : '0' }))
    .sort((a, b) => compareDecimals(b.fiatTurnover, a.fiatTurnover)) // decimal order, no float round-trip
    .slice(0, 5);

  // --- citations: coverage (C5) + event refs (C3) ---------------------------
  const { coverageRefs, coverageWarnings } = mapCoverage(coverage);
  const warnings: Warning[] = [
    ...coverageWarnings,
    ...pricingWarnings,
    { code: 'UNVERIFIED_EXCLUDED', message: 'unverified (spam-suspected) tokens were excluded from the close pack' },
  ];
  if (eventsTruncated) {
    warnings.push({
      code: 'COVERAGE_INCOMPLETE',
      message: `transactions.csv was truncated at ${String(events.length)} events; use analytics_list_events to enumerate the full set`,
      context: { truncated_events: events.length },
    });
  }
  const backings: BackingEvents[] = [
    ...closingBal.rows.map((r) => r.backing),
    ...flows.rows.map((r) => r.backing),
    ...gasRows.map((r) => r.backing),
    ...cpResult.rows.map((r) => r.backing),
  ];
  const refsParts = selectRefs(backings, {
    tool: 'analytics_list_events',
    args: { ...(input.scope !== undefined ? { scope: input.scope } : {}), period: { from: start, to: end } },
  });

  return {
    period,
    currency,
    scope,
    balancesOpening,
    balancesClosing,
    transactions,
    gas,
    counterparties,
    journal,
    ...(totalFiat(openingFiat) !== undefined ? { openingTotalFiat: totalFiat(openingFiat)! } : {}),
    ...(totalFiat(closingFiat) !== undefined ? { closingTotalFiat: totalFiat(closingFiat)! } : {}),
    ...(netFlowsFiat !== undefined ? { netFlowsFiat } : {}),
    ...(gasTotalFiat !== undefined ? { gasTotalFiat } : {}),
    topCounterparties,
    coverageRefs,
    priceRefs: [...priceRefMap.values()],
    fxRefs: [...fxRefMap.values()],
    warnings,
    refsParts,
  };
}

function balanceExport(r: BalanceRow, fiat: string | undefined): BalanceExportRow {
  return {
    address: r.address,
    chainId: r.chainId,
    token: tokenLabel(r.token),
    amount: r.amount as string,
    ...(fiat !== undefined ? { fiatValue: fiat } : {}),
  };
}

function transactionExport(e: EventListItem): TransactionExportRow {
  return {
    chainId: e.chainId,
    txHash: e.txHash,
    logIndex: e.logIndex,
    blockTime: e.blockTime,
    kind: e.kind,
    token: tokenLabel(e.token),
    amount: e.amount as string,
    direction: e.direction,
    from: e.fromAddr,
    to: e.toAddr,
  };
}

function gasExport(r: GasRow, fiat: string | undefined): GasExportRow {
  return {
    chainId: r.chainId,
    nativeSymbol: r.token.symbolDisplay ?? '',
    nativeAmount: r.nativeAmount as string,
    txCount: r.txCount,
    ...(fiat !== undefined ? { fiatValue: fiat } : {}),
  };
}

const MAX_EVENT_PAGES = 500; // × limit 200 = 100k events

/**
 * Drain `analytics_list_events` pagination so the close pack lists every event.
 * `truncated: true` means the page cap was hit with more pages pending — the
 * caller surfaces that as a COVERAGE_INCOMPLETE warning rather than silently
 * dropping the tail. Only verified events (default spam filter) are listed.
 */
async function listAllEvents(
  ctx: ToolContext,
  params: { scope: { addresses: string[] }; period: { from: string; to: string } },
): Promise<{ events: EventListItem[]; truncated: boolean }> {
  const all: EventListItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const res = await listEvents(ctx.db, { ...params, limit: 200, includeUnverified: false, ...(cursor ? { cursor } : {}) });
    all.push(...res.events);
    if (res.nextCursor === undefined) return { events: all, truncated: false };
    cursor = res.nextCursor;
  }
  return { events: all, truncated: true };
}
