/**
 * Matching persistence (recon_suggest_matches, §6.4/ADR-010). The pure engine
 * (@reconcil/recon) scores; this layer owns the I/O: it loads the tenant's open
 * records and the candidate settlement events, values each candidate in the record's
 * currency, runs the engine, and persists the suggested legs.
 *
 * Valuation is hybrid (C4 "priced means pinned"): a same-currency **stablecoin** keeps
 * face value at peg (reproducible as amount × 1, no snapshot needed, P5); any other token
 * — a volatile token, or a stablecoin whose peg differs from the record currency — is
 * valued through the pricing read-core (`resolvePrices` + ECB `resolveFxRates` + `valueOne`)
 * at the event's block-time UTC date, pinning the winning `price_snapshot_id` (+ `fx_rate_id`
 * on a cross-currency conversion). A candidate with no usable snapshot/FX is dropped and the
 * record stays honestly open — never interpolated (ADR-007), and the gap surfaces as a
 * PRICE_MISSING warning on the envelope.
 *
 * Idempotent re-run: prior `status='suggested'` legs for the in-scope records are
 * deleted before the fresh suggestions are inserted, all in one transaction;
 * `confirmed`/`rejected` legs are never touched. Cross-row invariants (Σ applied ≤
 * event amount, record-status derivation) are enforced at confirmation (B4), not
 * here — a suggestion is only a proposal.
 */
import { formatUnits, parseUnits, type FxRef, type PriceRef, type Warning } from '@reconcil/core';
import {
  chainEvents, entityAddresses, externalRecords, matches, tokens, wallets, type Tx,
} from '@reconcil/db';
import type { TokenMeta } from '@reconcil/ledger';
import {
  isSupportedFxPair, priceKey, resolveFxRates, resolvePrices, valueOne,
  type Currency, type FxResolved,
  type FxRef as PricingFxRef, type PriceRef as PricingPriceRef, type ValueNeed,
} from '@reconcil/pricing';
import {
  suggestForRecord, type CandidateEvent, type MatchRecord, type RuleHit, type Tolerances,
} from '@reconcil/recon';
import { and, eq, gt, gte, inArray, lte, or, sql } from 'drizzle-orm';

import type { DbContext } from '../context.js';
import { toWireFxRef, toWirePriceRef } from '../pricing-refs.js';

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
  /** Pinned snapshots/FX backing the priced legs (C4); dedup'd. Empty on the face-value path. */
  priceRefs: PriceRef[];
  fxRefs: FxRef[];
  /** PRICE_MISSING / FX_DATE_SHIFTED surfaced while valuing candidates (C5). */
  warnings: Warning[];
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

/** Fiat currencies the pricing read-core can value into (ADR-007). */
const SUPPORTED_FIAT = new Set<string>(['USD', 'EUR']);

/** A candidate valued in a record's currency, with the pinned refs that back the figure. */
interface ValuedCandidate {
  valuedAmount: string;
  priceRef: PricingPriceRef;
  fxRef?: PricingFxRef;
  fxShifted: boolean;
}

/**
 * Value every candidate event into `target` via pinned market snapshots (+ ECB FX), keyed
 * by event id. Same-currency stablecoins are excluded here — the caller uses their face value
 * (P5). A token with no usable snapshot, no FX for a required conversion, or a snapshot
 * currency that isn't EUR↔USD-convertible to `target` (H5, e.g. a GBP-pegged stablecoin) is
 * simply absent from the map: the caller drops that candidate and raises PRICE_MISSING
 * (ADR-007, never interpolate — and never a wrong number, never a batch-failing throw).
 * Batched: one `resolvePrices` + at most one `resolveFxRates` for the whole set.
 */
async function valueEventsInto(
  tx: Tx,
  events: EventRow[],
  target: Currency,
): Promise<Map<number, ValuedCandidate>> {
  const out = new Map<number, ValuedCandidate>();
  const needs: (ValueNeed & { eventId: number })[] = events
    .filter((e) => !(e.isStablecoin && e.pegCurrency === target))
    .map((e) => ({
      eventId: e.id,
      tokenId: e.tokenId,
      date: e.blockTime.toISOString().slice(0, 10), // UTC day of the settlement
      amount: formatUnits(e.amountRaw, e.decimals),
      isStablecoin: e.isStablecoin,
      pegCurrency: e.pegCurrency,
      symbol: e.symbolDisplay,
    }));
  if (needs.length === 0) return out;

  const prices = await resolvePrices(tx, needs, { currency: target, policy: 'market' });
  const fxDates = new Set<string>();
  for (const n of needs) {
    const snap = prices.get(priceKey(n.tokenId, n.date));
    if (snap && snap.currency !== target && isSupportedFxPair(snap.currency, target)) fxDates.add(n.date);
  }
  const fx = fxDates.size > 0
    ? await resolveFxRates(tx, [...fxDates], { base: 'EUR', quote: 'USD' })
    : new Map<string, FxResolved>();

  for (const n of needs) {
    const snap = prices.get(priceKey(n.tokenId, n.date));
    if (!snap) continue;
    let fxResolved: FxResolved | undefined;
    if (snap.currency !== target) {
      if (!isSupportedFxPair(snap.currency, target)) continue; // unsupported pair → PRICE_MISSING at the caller
      fxResolved = fx.get(n.date);
      if (!fxResolved) continue; // required conversion has no rate → PRICE_MISSING at the caller
    }
    const r = valueOne(n, snap, target, fxResolved);
    out.set(n.eventId, {
      valuedAmount: r.value,
      priceRef: r.priceRef,
      ...(r.fxRef ? { fxRef: r.fxRef } : {}),
      fxShifted: r.warning?.code === 'FX_DATE_SHIFTED',
    });
  }
  return out;
}

export async function suggestMatches(
  ctx: DbContext,
  params: SuggestMatchesParams,
): Promise<SuggestMatchesResult> {
  const { period, clientId, recordIds, tolerances } = params;
  const windowDays = tolerances?.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;

  // The caller (runWriteTool) already holds an open transaction, so this nests as a
  // savepoint — the suggestion delete+insert stays atomic, and the whole thing rolls back
  // with the outer tx if the tool_call persist fails (C2).
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

    if (recRows.length === 0) return { rows: [], unmatchedRecords: 0, unmatchedSettlements: 0, priceRefs: [], fxRefs: [], warnings: [] };
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

    // 3. Candidate settlement events: verified-token transfers touching those wallets,
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
            // Verified tokens only (spam excluded); NOT stablecoin-only — volatile tokens are
            // now priced via the pricing read-core, unpriceable ones drop out downstream.
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

    // 6. Value candidate events into each record currency (batched once per currency).
    //    Same-currency stablecoins skip pricing (face value at peg); everything else is
    //    priced with pinned refs, and an unpriceable token simply won't appear in the map.
    const valuedByCurrency = new Map<string, Map<number, ValuedCandidate>>();
    for (const cur of new Set(recRows.map((r) => r.currency))) {
      if (SUPPORTED_FIAT.has(cur)) valuedByCurrency.set(cur, await valueEventsInto(tx, eventRows, cur as Currency));
    }

    // 7. Run the engine per record over its currency-and-direction-matched candidates.
    const eventById = new Map(eventRows.map((e) => [e.id, e]));
    const eligibleEventIds = new Set<number>();
    const usedEventIds = new Set<number>();
    const matchedRecordIds = new Set<string>();
    const openByRecord = new Map<string, string>(); // computed once, reused for the wire view
    const legRefs = new Map<string, { priceRef?: PricingPriceRef; fxRef?: PricingFxRef }>(); // `${recordId}|${eventId}`
    const pending: { recordId: string; leg: ReturnType<typeof suggestForRecord>[number] }[] = [];

    // PRICE_MISSING / FX_DATE_SHIFTED gathered while valuing candidates (C5); dedup'd.
    const warnings: Warning[] = [];
    const warned = new Set<string>();
    const warn = (code: 'PRICE_MISSING' | 'FX_DATE_SHIFTED', key: string, message: string): void => {
      const k = `${code}|${key}`;
      if (warned.has(k)) return;
      warned.add(k);
      warnings.push({ code, message });
    };

    for (const r of recRows) {
      const inbound = r.direction === 'receivable';
      const valued = valuedByCurrency.get(r.currency);
      const candidates: CandidateEvent[] = [];
      for (const e of eventRows) {
        // Direction gate: the payer (from) settles a receivable; the payee (to) a payable.
        if (inbound ? !addrSet.has(e.toAddr) : !addrSet.has(e.fromAddr)) continue;

        let valuedAmount: string;
        let priceRef: PricingPriceRef | undefined;
        let fxRef: PricingFxRef | undefined;
        const day = e.blockTime.toISOString().slice(0, 10);
        if (e.isStablecoin && e.pegCurrency === r.currency) {
          valuedAmount = formatUnits(e.amountRaw, e.decimals); // face value at peg (P5), no refs
        } else {
          const v = valued?.get(e.id);
          if (v === undefined) {
            // A settlement that could have matched but has no usable price → honest open (ADR-007),
            // surfaced as a warning either way — never a silent under-match on a money tool. The
            // record currency may itself be unvaluable: external_records.currency has no DB CHECK
            // (only the importer's zod enum guards it), so guard the whole tool, not just the happy
            // path. Don't echo the raw currency there — it's an imported string (hostile-input).
            if (SUPPORTED_FIAT.has(r.currency)) {
              warn('PRICE_MISSING', `${String(e.id)}|${r.currency}`, `no ${r.currency} price for token ${String(e.tokenId)} on ${day}`);
            } else {
              warn('PRICE_MISSING', `ccy|${r.id}`, `record ${r.id} has a currency that cannot be valued (only USD and EUR are supported); its non-stablecoin settlements were left unmatched`);
            }
            continue;
          }
          valuedAmount = v.valuedAmount;
          priceRef = v.priceRef;
          fxRef = v.fxRef;
          if (v.fxShifted) warn('FX_DATE_SHIFTED', `${String(e.id)}|${r.currency}`, `ECB rate shifted for token ${String(e.tokenId)} valuation on ${day}`);
        }

        eligibleEventIds.add(e.id);
        legRefs.set(`${r.id}|${String(e.id)}`, { ...(priceRef ? { priceRef } : {}), ...(fxRef ? { fxRef } : {}) });
        candidates.push({
          eventId: e.id,
          amountRaw: e.amountRaw,
          tokenDecimals: e.decimals,
          valuedAmount,
          blockTime: e.blockTime.toISOString(),
          // Lowercased for safe === against the expected/known addresses.
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

    // 8. Replace un-actioned suggestions for the in-scope records, then insert the fresh legs.
    await tx.delete(matches).where(
      and(eq(matches.tenantId, ctx.tenantId), eq(matches.status, 'suggested'), inArray(matches.externalRecordId, recIds)),
    );

    let insertedIds: { id: string }[] = [];
    if (pending.length > 0) {
      insertedIds = await tx
        .insert(matches)
        .values(pending.map((p) => {
          const r = recById.get(p.recordId)!;
          const ref = legRefs.get(`${p.recordId}|${String(p.leg.eventId)}`);
          return {
            tenantId: ctx.tenantId,
            externalRecordId: p.recordId,
            chainEventId: p.leg.eventId,
            amountAppliedRaw: p.leg.amountAppliedRaw,
            fiatValue: p.leg.fiatValue,
            fiatCurrency: r.currency,
            // Pin the snapshot/FX the value came from (C4); null on the stablecoin face-value path.
            priceSnapshotId: ref?.priceRef?.snapshotId ?? null,
            fxRateId: ref?.fxRef?.fxRateId ?? null,
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

    // Dedup the pinned refs actually backing a persisted leg into the envelope citation pool.
    const priceRefPool = new Map<number, PricingPriceRef>();
    const fxRefPool = new Map<number, PricingFxRef>();
    for (const p of pending) {
      const ref = legRefs.get(`${p.recordId}|${String(p.leg.eventId)}`);
      if (ref?.priceRef) priceRefPool.set(ref.priceRef.snapshotId, ref.priceRef);
      if (ref?.fxRef) fxRefPool.set(ref.fxRef.fxRateId, ref.fxRef);
    }

    return {
      rows,
      unmatchedRecords: recRows.length - matchedRecordIds.size,
      // An event suggested against several records counts as "used" once, so this can
      // under-report leftover settlements. Acceptable for suggestions; the B5 status tool
      // is the authoritative unmatched-settlement view.
      unmatchedSettlements: eligibleEventIds.size - usedEventIds.size,
      priceRefs: [...priceRefPool.values()].map(toWirePriceRef),
      fxRefs: [...fxRefPool.values()].map(toWireFxRef),
      warnings,
    };
  });
}
