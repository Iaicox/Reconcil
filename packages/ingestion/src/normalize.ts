import type {
  NormalizedEvent,
  Page,
  RawInternalTx,
  RawNativeTx,
  RawReceipt,
} from './types.js';
import type { Erc20WithMeta } from './logindex.js';

/** Trace-level internal transfer n → sentinel log_index (ADR-005 d2). */
const INTERNAL_SENTINEL_BASE = -1000;

/**
 * Decimal-digits only. `Number()` was the old test and it is far too generous for a trace
 * label: it reads '' as 0, '0x10' as 16 and '1e3' as 1000, putting three non-numeric
 * segments into the numeric class. Real Etherscan/Blockscout trace ids are digits and
 * underscores, so nothing that actually occurs changes class under the stricter test.
 */
const DECIMAL_SEGMENT = /^[0-9]+$/;

/**
 * Numeric order of two all-digit strings, without parsing either. `BigInt(x)` was correct
 * (a `Number` would collapse distinct labels past 2^53 onto one float) but it heap-allocates
 * twice per comparison inside a sort's inner loop, run per parent-tx group on every ingested
 * page — for labels that are one to three digits in practice. Skip leading zeros, then more
 * digits means larger, and on equal length the digit strings compare lexicographically in
 * exactly numeric order. Same total order, no allocation, and "007" === "7" is now the
 * stated rule rather than a side effect of BigInt equality.
 */
function compareDecimalDigits(a: string, b: string): number {
  let ia = 0;
  let ib = 0;
  while (ia < a.length - 1 && a.charCodeAt(ia) === 0x30) ia += 1;
  while (ib < b.length - 1 && b.charCodeAt(ib) === 0x30) ib += 1;
  const la = a.length - ia;
  const lb = b.length - ib;
  if (la !== lb) return la < lb ? -1 : 1;
  for (let i = 0; i < la; i += 1) {
    const ca = a.charCodeAt(ia + i);
    const cb = b.charCodeAt(ib + i);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return 0;
}

/**
 * Order two trace labels segment by segment. Exported for its own property test.
 *
 * This must be a CONSISTENT comparator (a strict weak ordering), because `sort` is only
 * defined for one and its result becomes the `log_index` sentinel on every internal
 * transfer — half of the `UNIQUE (chain_id, tx_hash, log_index, token_id)` idempotency key
 * (ADR-005). It previously was not: a numeric-vs-non-numeric pair fell through to a raw
 * string comparison, which cycles against the numeric comparison used by numeric pairs —
 * "9" < "10" < "1a" < "9". Sorting on a comparator that contradicts itself is
 * implementation-defined, so the sentinel could depend on the engine and on arrival order.
 *
 * The rule that removes the cycle: the two classes are totally ordered against each other
 * (every numeric segment sorts before every non-numeric one) instead of being compared by a
 * measure that only makes sense inside one class. And two DISTINCT labels never compare
 * equal, so the caller's arrival-order tiebreak is only ever reached for a genuine repeat.
 */
export function compareTraceIds(a: string, b: string): number {
  const pa = a.split('_');
  const pb = b.split('_');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i];
    const xb = pb[i];
    // A prefix sorts before what extends it — "0_1" before "0_1_0".
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    if (xa === xb) continue;
    const numA = DECIMAL_SEGMENT.test(xa);
    const numB = DECIMAL_SEGMENT.test(xb);
    if (numA && numB) {
      const cmp = compareDecimalDigits(xa, xb);
      if (cmp !== 0) return cmp;
      // Equal as numbers ("007" vs "7"): fall through to the next segment. The whole-label
      // tiebreak at the bottom is what separates them if every segment ties.
      continue;
    }
    if (numA !== numB) return numA ? -1 : 1;
    return xa < xb ? -1 : 1;
  }
  // Every segment compared equal. If the LABELS still differ — "007" vs "7", equal as
  // numbers — returning 0 would hand the ordering to the caller's `a.arrival - b.arrival`
  // tiebreak, i.e. to the provider's response order. That is precisely the arrival-order
  // dependence ADR-005 d2 forbids: re-fetching the tx at an overlap boundary, or after a
  // failover, can return the rows the other way round, and the two would then get each
  // other's sentinel — ON CONFLICT DO NOTHING no longer dedupes, one value move is stored
  // twice and another is lost. The raw string is a total order, so distinct labels get a
  // stable relative position that depends on nothing but the labels themselves.
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}

/** An internal row that actually moves value, tagged with its position in the page. */
interface InternalValueMove {
  it: RawInternalTx & { to: string };
  arrival: number;
}

/**
 * Trace-id-free fallback order: (from, to, value), lowercased so a provider's
 * address casing cannot change the answer. Ties (two byte-identical traces in one
 * tx) are broken by arrival order at the call site.
 */
function compareTraceTuple(a: RawInternalTx, b: RawInternalTx): number {
  const fa = a.from.toLowerCase();
  const fb = b.from.toLowerCase();
  if (fa !== fb) return fa < fb ? -1 : 1;
  const ta = (a.to ?? '').toLowerCase();
  const tb = (b.to ?? '').toLowerCase();
  if (ta !== tb) return ta < tb ? -1 : 1;
  const va = BigInt(a.value);
  const vb = BigInt(b.value);
  if (va !== vb) return va < vb ? -1 : 1;
  return 0;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface NormalizeContext {
  chainId: number;
  trackedAddress: string;
  feeStrategy: 'txlist' | 'receipts-opstack';
  provider: string;
  /** keyed by lowercase tx hash; required for outgoing txs under receipts-opstack */
  receipts?: ReadonlyMap<string, RawReceipt>;
}

/**
 * Pure canonicalization (spec §8): lowercase, bigint, kind mapping, gas synthesis.
 * Cross-page dedup is the DB idempotency key's job (ADR-005) — not done here.
 */
export function normalize(
  input: {
    native?: Page<RawNativeTx> | undefined;
    internal?: Page<RawInternalTx> | undefined;
    erc20?: Page<Erc20WithMeta> | undefined;
  },
  ctx: NormalizeContext,
): NormalizedEvent[] {
  const tracked = ctx.trackedAddress.toLowerCase();
  const events: NormalizedEvent[] = [];

  for (const tx of input.native?.items ?? []) {
    const from = tx.from.toLowerCase();
    const toAddr = tx.to === null ? ZERO_ADDRESS : tx.to.toLowerCase();
    const txFrom = from; // tx-level sender = row.from
    const txTo = tx.to === null ? null : tx.to.toLowerCase();
    const common = {
      chainId: ctx.chainId,
      txHash: tx.hash.toLowerCase(),
      token: { kind: 'native' } as const,
      blockNumber: BigInt(tx.blockNumber),
      blockTime: new Date(Number(tx.timeStamp) * 1000),
      provider: ctx.provider,
      txFrom,
      txTo,
      raw: tx,
    };

    // Failed txs move no value — but the gas below is still real.
    if (tx.isError === '0' && BigInt(tx.value) > 0n) {
      events.push({
        ...common,
        logIndex: -1,
        eventKind: 'native_transfer',
        fromAddr: from,
        toAddr,
        amountRaw: BigInt(tx.value),
      });
    }

    if (from === tracked) {
      events.push({
        ...common,
        logIndex: -2,
        eventKind: 'gas_fee',
        fromAddr: from,
        toAddr: ZERO_ADDRESS,
        amountRaw: gasFee(tx, ctx),
      });
    }
  }

  // Internal transfers (txlistinternal): contract-initiated native value moves that
  // txlist omits. No gas of their own (the parent tx's gas_fee covers it). Several can
  // share one parent tx, so each gets sentinel −(1000+n) (ADR-005 d2). Failed /
  // zero-value / contract-creation rows move no value → skipped, and consume no slot.
  //
  // n is the trace's RANK inside its parent tx under a stable order — the provider's
  // trace label when it sends one (Etherscan `traceId`, Blockscout `index`), else a
  // (from, to, value) tuple — never arrival order. The append-only idempotency key
  // (chain_id, tx_hash, log_index, token_id) therefore depends only on the row set, so
  // the same tx re-fetched (the overlap-by-one boundary block, or the same window
  // served by the other provider after a failover) re-derives the same keys and ON
  // CONFLICT DO NOTHING dedupes it. Arrival-order numbering would renumber the traces
  // into each other's slots and silently drop a real value movement.
  //
  // The rank is computed over the traces PRESENT IN THIS CALL, so it is only a stable
  // key for a WHOLE tx: a truncated page holds a prefix of one, and a prefix can rank
  // differently from the full set (the tuple fallback reorders freely, and a group with
  // mixed labelled/unlabelled traces can even switch comparators between the two calls).
  // That is a write-side concern, and processors/ingest.ts owns it: it never commits an
  // event above the new cursor, so a truncated tx is withheld and stored only once its
  // whole trace set has been fetched. Anything that feeds `internal` here must uphold
  // the same rule — pass whole transactions, or drop the partial one.
  //
  // One residual caveat, accepted: two byte-identical traces in one tx (same
  // from/to/value) with no trace label tie, and fall back to the provider's response
  // order among the ties.
  //
  // Emission stays in arrival order; only the sentinel comes from the rank.
  const internalRows: InternalValueMove[] = (input.internal?.items ?? [])
    .map((it, arrival) => ({ it, arrival }))
    .filter(
      (r): r is InternalValueMove =>
        r.it.isError === '0' && r.it.to !== null && BigInt(r.it.value) > 0n,
    );
  const byParentTx = new Map<string, InternalValueMove[]>();
  for (const row of internalRows) {
    const txHash = row.it.hash.toLowerCase();
    const group = byParentTx.get(txHash);
    if (group) group.push(row);
    else byParentTx.set(txHash, [row]);
  }
  const sentinelRank = new Map<number, number>(); // arrival index → n
  for (const group of byParentTx.values()) {
    // Per group: label order iff every trace in it carries a label (one page comes
    // from one provider, so a mixed group is not a real shape — but be explicit).
    const labelled = group.every(({ it }) => (it.traceId ?? '') !== '');
    [...group]
      .sort((a, b) => {
        const primary = labelled
          ? compareTraceIds(a.it.traceId ?? '', b.it.traceId ?? '')
          : compareTraceTuple(a.it, b.it);
        return primary !== 0 ? primary : a.arrival - b.arrival;
      })
      .forEach((row, n) => sentinelRank.set(row.arrival, n));
  }

  for (const { it, arrival } of internalRows) {
    const txHash = it.hash.toLowerCase();
    // No `?? 0` fallback. Every arrival index is ranked above — the grouping loop walks
    // exactly `internalRows` — so a miss means that invariant broke, and defaulting to 0
    // would hand a SECOND row in the same tx the sentinel the first already has. That is
    // the `UNIQUE (chain_id, tx_hash, log_index, token_id)` key (ADR-005): the page would
    // either fail on the constraint or, under ON CONFLICT DO NOTHING, silently drop a real
    // value move. Fail loudly where the invariant broke instead of one layer down.
    const n = sentinelRank.get(arrival);
    if (n === undefined) {
      throw new Error(`internal-transfer sentinel rank missing for arrival index ${String(arrival)} (tx ${txHash})`);
    }
    events.push({
      chainId: ctx.chainId,
      txHash,
      logIndex: INTERNAL_SENTINEL_BASE - n,
      eventKind: 'native_transfer',
      token: { kind: 'native' },
      fromAddr: it.from.toLowerCase(),
      toAddr: it.to.toLowerCase(),
      amountRaw: BigInt(it.value),
      blockNumber: BigInt(it.blockNumber),
      blockTime: new Date(Number(it.timeStamp) * 1000),
      provider: ctx.provider,
      // tx-level from/to mirror the internal endpoints — chain_events.tx_from/tx_to are
      // NOT NULL and an internal transfer has no distinct outer tx envelope here. So
      // counterparty/initiator analytics over an internal inflow see the internal sender
      // (the contract that sent the value), not the outer tx's originator. For an inflow
      // that internal sender IS the meaningful counterparty, so this is a deliberate choice,
      // not a misattribution; a txlist⋈txlistinternal join could recover the outer
      // originator if initiator-level analytics ever need it (follow-up, not needed today).
      txFrom: it.from.toLowerCase(),
      txTo: it.to.toLowerCase(),
      raw: it,
    });
  }

  for (const t of input.erc20?.items ?? []) {
    // Peel off the receipt-derived fields so `raw` holds the untouched provider
    // row (its documented contract) — logIndex/txFrom/txTo are already first-class
    // columns, not part of the source payload.
    const { logIndex, txFrom, txTo, ...rawRow } = t;
    events.push({
      chainId: ctx.chainId,
      txHash: t.hash.toLowerCase(),
      logIndex: Number(logIndex),
      eventKind: 'erc20_transfer',
      token: {
        kind: 'erc20',
        contract: t.contractAddress.toLowerCase(),
        decimals: t.tokenDecimal,
        symbolRaw: t.tokenSymbol,
        nameRaw: t.tokenName,
      },
      fromAddr: t.from.toLowerCase(),
      toAddr: t.to.toLowerCase(),
      amountRaw: BigInt(t.value),
      blockNumber: BigInt(t.blockNumber),
      blockTime: new Date(Number(t.timeStamp) * 1000),
      provider: ctx.provider,
      txFrom,
      txTo,
      raw: rawRow,
    });
  }

  return events;
}

function gasFee(tx: RawNativeTx, ctx: NormalizeContext): bigint {
  if (ctx.feeStrategy === 'txlist') {
    return BigInt(tx.gasUsed) * BigInt(tx.gasPrice);
  }
  const receipt = ctx.receipts?.get(tx.hash.toLowerCase());
  if (!receipt) {
    throw new Error('missing receipt for outgoing tx — receipts-opstack requires receipts before normalize()', {
      cause: tx.hash.toLowerCase(),
    });
  }
  const l2 = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  return receipt.l1Fee === null ? l2 : l2 + BigInt(receipt.l1Fee);
}
