/**
 * `analytics_balances` (contract §6.1) — token balances per wallet, optionally
 * valued. Composes ledger quantities (`computeBalances`) with pricing
 * (`valueQuantities`) behind the citation envelope: every figure is reproducible
 * from `event_refs`/`event_ref_summary` (C1/C3) and pinned `price_refs`/`fx_refs`
 * (C4); coverage gaps surface as warnings (C5); only sanitized `*_display` symbols
 * reach the response (C6). The tool_call is persisted before returning (C2).
 */
import {
  analyticsBalancesInput, analyticsBalancesOutput,
  type AnalyticsBalancesInput, type AnalyticsBalancesOutput, type CoverageRef,
  type FxRef, type PriceRef, type TokenView, type Warning,
} from '@pet-crypto/core';
import {
  computeBalances, getLedgerStatus, type TokenMeta, type WalletCoverage,
} from '@pet-crypto/ledger';
import { sumDecimals, valueQuantities, type ValueNeed } from '@pet-crypto/pricing';

import type { ToolContext } from '../context.js';
import { buildEnvelope, type EnvelopeParts, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { resolveScope } from '../scope.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'analytics_balances';
const REF_CAP = 64;

type WireEventRef = { chain_id: number; tx_hash: string; log_index: number };

export async function analyticsBalances(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<AnalyticsBalancesOutput>> {
  const parsed = analyticsBalancesInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const { addresses } = await resolveScope(ctx, input.scope);
  const includeUnverified = input.include_unverified ?? false;

  // computeBalances and getLedgerStatus (coverage, C5) are independent — one round-trip wave.
  const [balances, coverage] = await Promise.all([
    computeBalances(ctx.db, {
      scope: { addresses, ...(input.chain_ids ? { chainIds: input.chain_ids } : {}) },
      ...(input.as_of ? { asOf: input.as_of } : {}),
      includeUnverified,
    }),
    getLedgerStatus(ctx.db, { addresses, ...(input.chain_ids ? { chainIds: input.chain_ids } : {}) }),
  ]);

  const dateByChain = new Map<number, string>();
  for (const a of balances.asOf) dateByChain.set(a.chainId, a.date);
  const fallbackDate = input.as_of ?? new Date().toISOString().slice(0, 10);
  const dateForRow = (chainId: number): string => input.as_of ?? dateByChain.get(chainId) ?? fallbackDate;

  // --- valuation (optional) -------------------------------------------------
  const warnings: Warning[] = [];
  const priceRefs: PriceRef[] = [];
  const fxRefs: FxRef[] = [];
  let fiatByIndex: (string | undefined)[] = [];
  if (input.valuation) {
    const needs: ValueNeed[] = balances.rows.map((r) => ({
      tokenId: r.token.tokenId,
      date: dateForRow(r.chainId),
      amount: r.amount,
      isStablecoin: r.token.isStablecoin,
      pegCurrency: r.token.pegCurrency,
      symbol: r.token.symbolDisplay,
    }));
    const v = input.valuation;
    const valuation = v.policy !== undefined ? { currency: v.currency, policy: v.policy } : { currency: v.currency };
    const valued = await valueQuantities(ctx.db, needs, valuation);
    fiatByIndex = valued.values.map((v) => v.fiatValue);
    for (const p of valued.priceRefs) {
      priceRefs.push({ snapshot_id: p.snapshotId, token: p.token, date: p.date, currency: p.currency, source: p.source, price: p.price });
    }
    for (const f of valued.fxRefs) {
      fxRefs.push({ fx_rate_id: f.fxRateId, date: f.date, base: f.base, quote: f.quote, rate: f.rate, source: f.source });
    }
    for (const w of valued.warnings) warnings.push({ code: w.code, message: w.message, ...(w.context ? { context: w.context } : {}) });
  }

  // --- data -----------------------------------------------------------------
  const outBalances = balances.rows.map((r, i) => {
    const fiat = input.valuation ? fiatByIndex[i] : undefined;
    return {
      address: r.address,
      chain_id: r.chainId,
      token: toTokenView(r.token),
      amount: r.amount as string,
      ...(fiat !== undefined ? { fiat_value: fiat } : {}),
    };
  });

  let totals: { currency: string; value: string }[] | undefined;
  if (input.valuation) {
    const fiats = outBalances.map((b) => b.fiat_value).filter((x): x is string => x !== undefined);
    // Omit totals when nothing priced — a '0' total would misread as "zero value"
    // rather than "unpriced" (the PRICE_MISSING warning already carries that).
    if (fiats.length > 0) totals = [{ currency: input.valuation.currency, value: sumDecimals(fiats) }];
  }

  const asOfEffective = {
    date: input.as_of ?? (balances.asOf.length > 0 ? [...balances.asOf].map((a) => a.date).sort().at(-1)! : fallbackDate),
    per_chain: balances.asOf.filter((a) => a.block !== null).map((a) => ({ chain_id: a.chainId, block: a.block as number })),
  };

  const data: AnalyticsBalancesOutput = { as_of_effective: asOfEffective, balances: outBalances, ...(totals ? { totals } : {}) };

  // --- coverage + warnings (C5) --------------------------------------------
  const { coverageRefs, coverageWarnings } = mapCoverage(coverage);
  warnings.push(...coverageWarnings);
  if (!includeUnverified) {
    warnings.push({ code: 'UNVERIFIED_EXCLUDED', message: 'unverified (spam-suspected) tokens were excluded; pass include_unverified to include them' });
  }

  // --- citations: event refs / drilldown (C3) ------------------------------
  const allRefs: WireEventRef[] = [];
  let totalCount = 0;
  for (const r of balances.rows) {
    totalCount += r.backing.totalCount;
    for (const e of r.backing.refs) allRefs.push({ chain_id: e.chainId, tx_hash: e.txHash, log_index: e.logIndex });
  }
  const deduped = dedupeRefs(allRefs);
  const refsParts: Pick<EnvelopeParts, 'eventRefs' | 'eventRefSummary'> =
    totalCount <= REF_CAP && deduped.length <= REF_CAP
      ? { eventRefs: deduped }
      : {
          eventRefSummary: {
            count: totalCount,
            sample: deduped.slice(0, 10),
            drilldown: { tool: 'analytics_list_events', args: drilldownArgs(input) },
          },
        };

  // --- validate the contract shape, THEN persist (C2), then respond --------
  // Validate first so a bug-produced bad result can't leave an orphan tool_calls
  // row it never returns; C2 still holds — persist precedes the response.
  try {
    analyticsBalancesOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `analytics_balances produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: coverageRefs, result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: coverageRefs, ...refsParts, priceRefs, fxRefs, warnings });
}

// Only sanitized `*_display` reaches responses (C6); the raw value never leaves the server.
// FOLLOW-UP (cross-package): when symbolDisplay is empty the contract wants
// `untrusted.symbol_raw_sanitized` (§6.1) and a SANITIZED_HEAVY warning — both need
// TokenMeta to carry the sanitized RAW symbol + its `heavy` flag, which ledger/core
// don't surface yet (needs a persisted heavy flag + a raw-fallback on the token
// registry). Until then a nameless token shows symbol ''.
function toTokenView(t: TokenMeta): TokenView {
  return {
    chain_id: t.chainId,
    address: t.address,
    symbol: t.symbolDisplay ?? '',
    decimals: t.decimals,
    is_stablecoin: t.isStablecoin,
    ...(t.pegCurrency !== null ? { peg_currency: t.pegCurrency } : {}),
    verified: t.verified,
  };
}

function mapCoverage(cov: WalletCoverage[]): { coverageRefs: CoverageRef[]; coverageWarnings: Warning[] } {
  const refs: CoverageRef[] = [];
  let incomplete = false;
  let anchored = false;
  let stale = false;
  for (const w of cov) {
    const status: CoverageRef['status'] = w.streams.some((s) => s.status === 'error')
      ? 'error'
      : w.streams.some((s) => s.status === 'backfilling')
        ? 'backfilling'
        : w.streams.some((s) => s.status === 'paused')
          ? 'paused'
          : 'live';
    const anchorBlock = w.streams.map((s) => s.anchorBlock).find((b) => b !== undefined);
    refs.push({
      chain_id: w.chainId,
      address: w.address,
      streams: w.streams.map((s) => s.stream),
      from_block: null,
      to_block: Math.max(0, ...w.streams.map((s) => s.lastProcessedBlock)),
      ...(anchorBlock !== undefined ? { anchor_block: anchorBlock } : {}),
      status,
    });
    if (w.streams.some((s) => s.status !== 'live')) incomplete = true;
    if (w.anchored) anchored = true;
    if (w.streams.some((s) => s.stale)) stale = true;
  }
  const coverageWarnings: Warning[] = [];
  if (incomplete) coverageWarnings.push({ code: 'COVERAGE_INCOMPLETE', message: 'a wallet/stream in scope is still backfilling or errored' });
  if (anchored) coverageWarnings.push({ code: 'ANCHORED_BASELINE', message: 'balances rest on an opening_balance anchor, not full history' });
  if (stale) coverageWarnings.push({ code: 'DATA_STALE', message: 'a checkpoint in scope is older than the freshness threshold' });
  return { coverageRefs: refs, coverageWarnings };
}

function dedupeRefs(refs: WireEventRef[]): WireEventRef[] {
  const seen = new Set<string>();
  const out: WireEventRef[] = [];
  for (const r of refs) {
    const k = `${String(r.chain_id)}|${r.tx_hash}|${String(r.log_index)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function drilldownArgs(input: AnalyticsBalancesInput): Record<string, unknown> {
  return { ...(input.scope !== undefined ? { scope: input.scope } : {}), ...(input.chain_ids ? { chain_ids: input.chain_ids } : {}) };
}
