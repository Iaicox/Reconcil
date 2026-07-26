/**
 * Matching persistence (recon_suggest_matches, §6.4/ADR-010). The pure engine
 * (@reconcil/recon) scores; this layer owns the I/O: it loads the tenant's open
 * records and the candidate settlement events, values each candidate at stablecoin
 * face value in the record's currency (first cut — volatile-token valuation via the
 * pricing slice is a follow-up), runs the engine, and persists the suggested legs.
 *
 * Idempotent re-run: prior `status='suggested'` legs for the in-scope records are
 * deleted before the fresh suggestions are inserted, all in one transaction;
 * `confirmed`/`rejected` legs are never touched. Cross-row invariants (Σ applied ≤
 * event amount, record-status derivation) are enforced at confirmation (B4), not
 * here — a suggestion is only a proposal.
 */
import { formatUnits, parseUnits } from '@reconcil/core';
import {
  chainEvents, entityAddresses, externalRecords, matches, tokens, wallets,
} from '@reconcil/db';
import type { TokenMeta } from '@reconcil/ledger';
import {
  suggestForRecord, type CandidateEvent, type MatchRecord, type RuleHit, type Tolerances,
} from '@reconcil/recon';
import { and, eq, gt, gte, inArray, lte, or, sql } from 'drizzle-orm';

import type { ToolContext } from '../context.js';

const DEFAULT_DATE_WINDOW_DAYS = 14;
const MS_PER_DAY = 86_400_000;

/** Records the engine may still match against (typed for drizzle `inArray` inference). */
const OPEN_STATES: ('open' | 'partially_matched')[] = ['open', 'partially_matched'];
/** Event kinds that can settle a record (transfers only; gas/opening-balance excluded). */
const SETTLEMENT_KINDS: ('erc20_transfer' | 'native_transfer')[] = ['erc20_transfer', 'native_transfer'];

export interface SuggestMatchesParams {
  period?: { from: string; to: string };
  /** Resolved+validated client id to scope to; undefined = all of the tenant's records. */
  clientId?: string;
  recordIds?: string[];
  tolerances?: Tolerances;
}

export interface SuggestionRow {
  matchId: string;
  record: { id: string; externalRef: string; amount: string; currency: string; openAmount: string };
  event: {
    chainId: number; txHash: string; logIndex: number; token: TokenMeta;
    amount: string; blockTime: string; fromAddr: string;
  };
  amountApplied: string;
  fiatValue: string;
  confidence: number;
  rationale: RuleHit[];
}

export interface SuggestMatchesResult {
  rows: SuggestionRow[];
  unmatchedRecords: number;
  unmatchedSettlements: number;
}

interface EventRow {
  id: number;
  chainId: number;
  txHash: string;
  logIndex: number;
  amountRaw: bigint;
  fromAddr: string;
  toAddr: string;
  blockTime: Date;
  tokenId: number;
  tokenAddress: string | null;
  decimals: number;
  symbolDisplay: string | null;
  isStablecoin: boolean;
  pegCurrency: string | null;
  verified: boolean;
}

const fracDigits = (s: string): number => {
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
};

/** Exact decimal subtraction (a − b) with no float; both are decimal strings. */
function subtractDecimal(a: string, b: string): string {
  const scale = Math.max(fracDigits(a), fracDigits(b));
  return formatUnits(parseUnits(a, scale) - parseUnits(b, scale), scale);
}

export async function suggestMatches(
  ctx: ToolContext,
  params: SuggestMatchesParams,
): Promise<SuggestMatchesResult> {
  const { period, clientId, recordIds, tolerances } = params;
  const windowDays = tolerances?.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;

  return ctx.db.transaction(async (tx) => {
    // 1. Open records in scope (tenant-scoped; optional client / record-id / period filters).
    const recRows = await tx
      .select({
        id: externalRecords.id,
        externalRef: externalRecords.externalRef,
        amount: externalRecords.amount,
        currency: externalRecords.currency,
        direction: externalRecords.direction,
        issuedOn: externalRecords.issuedOn,
        dueOn: externalRecords.dueOn,
        expectedAddress: externalRecords.expectedAddress,
        counterpartyEntityId: externalRecords.counterpartyEntityId,
      })
      .from(externalRecords)
      .where(
        and(
          eq(externalRecords.tenantId, ctx.tenantId),
          inArray(externalRecords.status, OPEN_STATES),
          clientId !== undefined ? eq(externalRecords.clientId, clientId) : undefined,
          recordIds !== undefined ? inArray(externalRecords.id, recordIds) : undefined,
          period !== undefined ? gte(externalRecords.issuedOn, period.from) : undefined,
          period !== undefined ? lte(externalRecords.issuedOn, period.to) : undefined,
        ),
      )
      .orderBy(externalRecords.id); // stable suggestion order across runs

    if (recRows.length === 0) return { rows: [], unmatchedRecords: 0, unmatchedSettlements: 0 };
    const recById = new Map(recRows.map((r) => [r.id, r]));
    const recIds = recRows.map((r) => r.id);

    // 2. The tenant's tracked wallets (optionally client-scoped) — the settlement endpoints.
    const walletRows = await tx
      .select({ address: wallets.address, clientId: wallets.clientId })
      .from(wallets)
      .where(eq(wallets.tenantId, ctx.tenantId));
    const scoped = clientId !== undefined ? walletRows.filter((w) => w.clientId === clientId) : walletRows;
    const addresses = [...new Set(scoped.map((w) => w.address))];
    const addrSet = new Set(addresses);

    // 3. Candidate settlement events: verified-stablecoin transfers touching those wallets,
    //    bounded to the union date window when every record carries a reference date.
    const refDates = recRows.map((r) => r.dueOn ?? r.issuedOn);
    let timeFrom: Date | undefined;
    let timeTo: Date | undefined;
    if (refDates.every((d): d is string => d !== null) && refDates.length > 0) {
      const ts = refDates.map((d) => Date.parse(d));
      timeFrom = new Date(Math.min(...ts) - windowDays * MS_PER_DAY);
      timeTo = new Date(Math.max(...ts) + (windowDays + 1) * MS_PER_DAY); // +1 day covers the whole 'to' day
    }

    let eventRows: EventRow[] = [];
    if (addresses.length > 0) {
      eventRows = await tx
        .select({
          id: chainEvents.id,
          chainId: chainEvents.chainId,
          txHash: chainEvents.txHash,
          logIndex: chainEvents.logIndex,
          amountRaw: chainEvents.amountRaw,
          fromAddr: chainEvents.fromAddr,
          toAddr: chainEvents.toAddr,
          blockTime: chainEvents.blockTime,
          tokenId: tokens.id,
          tokenAddress: tokens.address,
          decimals: tokens.decimals,
          symbolDisplay: tokens.symbolDisplay,
          isStablecoin: tokens.isStablecoin,
          pegCurrency: tokens.pegCurrency,
          verified: tokens.verified,
        })
        .from(chainEvents)
        .innerJoin(tokens, eq(tokens.id, chainEvents.tokenId))
        .where(
          and(
            or(inArray(chainEvents.fromAddr, addresses), inArray(chainEvents.toAddr, addresses)),
            inArray(chainEvents.eventKind, SETTLEMENT_KINDS),
            gt(chainEvents.amountRaw, 0n), // 0-value spam transfers can't settle anything
            eq(tokens.isStablecoin, true),
            eq(tokens.verified, true),
            timeFrom !== undefined ? gte(chainEvents.blockTime, timeFrom) : undefined,
            timeTo !== undefined ? lte(chainEvents.blockTime, timeTo) : undefined,
          ),
        )
        // Deterministic input order so the engine's tie-breaking is reproducible.
        .orderBy(chainEvents.blockTime, chainEvents.id);
    }

    // 4. Known counterparty addresses (address book) → the history rule signal.
    const entityIds = [...new Set(recRows.map((r) => r.counterpartyEntityId).filter((x): x is string => x !== null))];
    const knownByEntity = new Map<string, string[]>();
    if (entityIds.length > 0) {
      const rows = await tx
        .select({ entityId: entityAddresses.entityId, address: entityAddresses.address })
        .from(entityAddresses)
        .where(and(eq(entityAddresses.tenantId, ctx.tenantId), inArray(entityAddresses.entityId, entityIds)));
      for (const row of rows) {
        const list = knownByEntity.get(row.entityId) ?? [];
        list.push(row.address);
        knownByEntity.set(row.entityId, list);
      }
    }

    // 5. Confirmed applied fiat per record → open amount (records here are open/partial).
    const confSums = await tx
      .select({ recordId: matches.externalRecordId, sum: sql<string>`coalesce(sum(${matches.fiatValue}), 0)::text` })
      .from(matches)
      .where(and(eq(matches.tenantId, ctx.tenantId), eq(matches.status, 'confirmed'), inArray(matches.externalRecordId, recIds)))
      .groupBy(matches.externalRecordId);
    const confirmedByRecord = new Map(confSums.map((r) => [r.recordId, r.sum]));

    // 6. Run the engine per record over its currency-and-direction-matched candidates.
    const eventById = new Map(eventRows.map((e) => [e.id, e]));
    const eligibleEventIds = new Set<number>();
    const usedEventIds = new Set<number>();
    const matchedRecordIds = new Set<string>();
    const openByRecord = new Map<string, string>(); // computed once, reused for the wire view
    const pending: { recordId: string; leg: ReturnType<typeof suggestForRecord>[number] }[] = [];

    for (const r of recRows) {
      const inbound = r.direction === 'receivable';
      const candidates: CandidateEvent[] = [];
      for (const e of eventRows) {
        if (e.pegCurrency !== r.currency) continue; // value only same-currency stablecoins (first cut)
        if (inbound ? !addrSet.has(e.toAddr) : !addrSet.has(e.fromAddr)) continue;
        eligibleEventIds.add(e.id);
        candidates.push({
          eventId: e.id,
          amountRaw: e.amountRaw,
          tokenDecimals: e.decimals,
          valuedAmount: formatUnits(e.amountRaw, e.decimals),
          blockTime: e.blockTime.toISOString(),
          // The counterparty end depends on direction: the payer (from) settles a
          // receivable, the payee (to) receives a payable. Lowercased for safe ===.
          counterpartyAddr: (inbound ? e.fromAddr : e.toAddr).toLowerCase(),
        });
      }
      const openAmount = subtractDecimal(r.amount, confirmedByRecord.get(r.id) ?? '0');
      openByRecord.set(r.id, openAmount);
      const mrec: MatchRecord = {
        id: r.id,
        amount: r.amount,
        openAmount,
        currency: r.currency,
        issuedOn: r.issuedOn,
        dueOn: r.dueOn,
        // Lowercase insurance: expected_address is DB-CHECK-lowercased and ingestion
        // normalizes addresses, but the engine compares with raw === — keep it robust.
        expectedAddress: r.expectedAddress === null ? null : r.expectedAddress.toLowerCase(),
        knownCounterpartyAddresses: (r.counterpartyEntityId !== null ? (knownByEntity.get(r.counterpartyEntityId) ?? []) : []).map((a) => a.toLowerCase()),
      };
      const legs = suggestForRecord(mrec, candidates, tolerances ?? {});
      if (legs.length > 0) matchedRecordIds.add(r.id);
      for (const leg of legs) {
        usedEventIds.add(leg.eventId);
        pending.push({ recordId: r.id, leg });
      }
    }

    // 7. Replace un-actioned suggestions for the in-scope records, then insert the fresh legs.
    await tx.delete(matches).where(
      and(eq(matches.tenantId, ctx.tenantId), eq(matches.status, 'suggested'), inArray(matches.externalRecordId, recIds)),
    );

    let insertedIds: { id: string }[] = [];
    if (pending.length > 0) {
      insertedIds = await tx
        .insert(matches)
        .values(pending.map((p) => {
          const r = recById.get(p.recordId)!;
          return {
            tenantId: ctx.tenantId,
            externalRecordId: p.recordId,
            chainEventId: p.leg.eventId,
            amountAppliedRaw: p.leg.amountAppliedRaw,
            fiatValue: p.leg.fiatValue,
            fiatCurrency: r.currency,
            status: 'suggested' as const,
            matchedBy: 'auto' as const,
            confidence: p.leg.confidence.toString(),
            rationale: { rules: p.leg.rationale },
          };
        }))
        .returning({ id: matches.id });
    }

    // A single multi-row INSERT returns rows in VALUES order, so insertedIds[i] ↔ pending[i].
    const rows: SuggestionRow[] = pending.map((p, i) => {
      const r = recById.get(p.recordId)!;
      const e = eventById.get(p.leg.eventId)!;
      const token: TokenMeta = {
        tokenId: e.tokenId,
        chainId: e.chainId,
        address: e.tokenAddress,
        symbolDisplay: e.symbolDisplay,
        decimals: e.decimals,
        verified: e.verified,
        isStablecoin: e.isStablecoin,
        pegCurrency: e.pegCurrency,
      };
      return {
        matchId: insertedIds[i]!.id,
        record: { id: r.id, externalRef: r.externalRef, amount: r.amount, currency: r.currency, openAmount: openByRecord.get(r.id)! },
        event: {
          chainId: e.chainId,
          txHash: e.txHash,
          logIndex: e.logIndex,
          token,
          amount: formatUnits(e.amountRaw, e.decimals),
          blockTime: e.blockTime.toISOString(),
          fromAddr: e.fromAddr,
        },
        amountApplied: formatUnits(p.leg.amountAppliedRaw, e.decimals),
        fiatValue: p.leg.fiatValue,
        confidence: p.leg.confidence,
        rationale: p.leg.rationale,
      };
    });

    return {
      rows,
      unmatchedRecords: recRows.length - matchedRecordIds.size,
      // An event suggested against several records counts as "used" once, so this can
      // under-report leftover settlements. Acceptable for suggestions; the B5 status tool
      // is the authoritative unmatched-settlement view.
      unmatchedSettlements: eligibleEventIds.size - usedEventIds.size,
    };
  });
}
