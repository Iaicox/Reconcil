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

/** An internal row that actually moves value, tagged with its position in the page. */
interface InternalValueMove {
  it: RawInternalTx & { to: string };
  arrival: number;
}

/**
 * The ONLY rank source for the `-(1000+n)` sentinel (ADR-005 d2): the transfer's own
 * content, `(from, to, value)`, lowercased so a provider's address casing cannot change the
 * answer. Ties — two traces in one tx agreeing on all three — are broken by arrival order at
 * the call site, and that is sound rather than merely tolerated: rows with equal content are
 * interchangeable, so a re-fetch that returns them the other way round derives the same key
 * multiset and `ON CONFLICT DO NOTHING` still matches. See the call site for the one property
 * this deliberately gives up.
 *
 * A lexicographic composition of three total orders on the projected triple, so it is a
 * strict weak ordering: it returns 0 exactly when the triples are equal, which is an
 * equivalence relation. `toLowerCase()` (not `toLocaleLowerCase`) keeps it locale-invariant.
 *
 * `BigInt(value)` cannot throw here — not because of the `/^\d+$/` schema, but because the
 * caller's filter has already evaluated `BigInt(r.it.value) > 0n` on every row one step
 * earlier, so a malformed value fails there instead of inside a sort's inner loop.
 *
 * It does allocate two BigInts and two lowercased strings per comparison, which is the cost
 * the deleted label comparator was hand-optimized to avoid — and that argument applies more
 * strongly here, since this is now the only ranking path and values run to 78 digits. Left
 * as is deliberately: a parent-tx trace group is small, so the sort is effectively O(1) per
 * group and a precomputed sort key would trade legibility on an idempotency-key derivation
 * for nothing measurable. Note what that rests on — every captured fixture has 79 traces over
 * 79 distinct transactions, i.e. group size 1, so the comparator is never even called on
 * recorded data. That is evidence of absence, not of smallness; ADR-005 d2 uses the same
 * absence to call a provider claim untestable. Revisit with a profile, never on principle.
 *
 * Takes `InternalValueMove['it']`, not `RawInternalTx`: that filter also narrows `to` to a
 * string, so a `?? ''` fallback here would be an unreachable branch pretending otherwise.
 */
function compareTraceTuple(a: InternalValueMove['it'], b: InternalValueMove['it']): number {
  const fa = a.from.toLowerCase();
  const fb = b.from.toLowerCase();
  if (fa !== fb) return fa < fb ? -1 : 1;
  const ta = a.to.toLowerCase();
  const tb = b.to.toLowerCase();
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
  // n is the trace's RANK inside its parent tx under `compareTraceTuple` — (from, to,
  // value), the transfer's own content, and nothing else. Never arrival order, and (since
  // 2026-09-15) never the provider's trace label either. The append-only idempotency key
  // (chain_id, tx_hash, log_index, token_id) therefore depends only on the row set, so the
  // same tx re-fetched (the overlap-by-one boundary block, or the same window served by the
  // other provider after a failover) re-derives the same keys and ON CONFLICT DO NOTHING
  // dedupes it. Arrival-order numbering would renumber the traces into each other's slots
  // and silently drop a real value movement.
  //
  // Content satisfies that requirement by construction and a label cannot — which is why
  // the label path is gone rather than merely narrowed (ADR-005 d2). Two rows with equal
  // content are interchangeable by definition; two rows sharing a LABEL are not, and
  // patching that took two amendments in two consecutive review rounds.
  //
  // The rank is computed over the traces PRESENT IN THIS CALL, so it is only a stable key
  // for a WHOLE tx: a truncated page holds a prefix, and a prefix ranks differently from the
  // full set whenever the withheld rows sort before the kept ones. That is a write-side
  // concern and processors/ingest.ts owns it — it never commits an event above the new
  // cursor, so a truncated tx is withheld and stored only once its whole trace set has been
  // fetched. That guard is now the ONLY thing standing behind this: ranking by label used to
  // be prefix-stable as a side effect (providers enumerate in label order), and that
  // redundancy is deliberately given up, because it held only if a provider really does
  // enumerate that way — which nothing here verifies. Anything that feeds `internal` must
  // uphold the rule: pass whole transactions, or drop the partial one.
  //
  // The residual caveat, accepted and now the only one: two traces in one tx agreeing on
  // (from, to, value) tie and fall back to the provider's response order. Nothing is dropped
  // or duplicated — the key multiset and every derived column are identical either way. What
  // is NOT preserved is which `raw` payload sits under which sentinel, so a re-fetch in the
  // other order can swap their `raw.traceId`. That is harmless because chain_events.raw has
  // no readers, which is a fact about today's consumers rather than a property of the
  // design — so it is written down in ADR-005 d2 as a deliberately excluded property, not
  // asserted away.
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
    [...group]
      .sort((a, b) => {
        const primary = compareTraceTuple(a.it, b.it);
        // Reached only between rows with equal (from, to, value), which are interchangeable.
        // Written out rather than left to `Array.prototype.sort`'s stability: the result is
        // half an idempotency key, and a comparator that states its own tiebreak is a better
        // thing to rest that on than a guarantee living in someone else's spec.
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
