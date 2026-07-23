/**
 * `ledger_status` (contract §6.2) — data freshness and completeness per
 * (wallet, chain, stream): the agent's "can I trust this" check and the C5
 * authority. A reshape of the existing ledger coverage read (`getLedgerStatus`)
 * onto the citation envelope — `data.wallets` carries the per-stream detail,
 * `citations.coverage`/`warnings` carry the machine slice + C5 warnings
 * (COVERAGE_INCOMPLETE / ANCHORED_BASELINE / DATA_STALE). No figures, so no
 * event/price refs; the tool_call is persisted before returning (C2).
 */
import {
  decimalString, ledgerStatusInput, ledgerStatusOutput,
  type LedgerStatusOutput, type LedgerWalletStatusView,
} from '@pet-crypto/core';
import { getLedgerStatus } from '@pet-crypto/ledger';
import { z } from 'zod';

import type { ToolContext } from '../context.js';
import { mapCoverage } from '../coverage.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { resolveScope } from '../scope.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'ledger_status';

/** Stored `last_integrity` JSONB shape (ADR-005 d4): `{checked_at, block, drifts}`
 *  — `clean` is derived. A malformed/legacy row is dropped, not surfaced. */
const rawIntegrity = z.object({
  checked_at: z.string(),
  block: z.number(),
  drifts: z.array(z.object({ token: z.string(), computed: decimalString, provider: decimalString })),
});

function shapeIntegrity(raw: unknown): LedgerWalletStatusView['integrity'] {
  const parsed = rawIntegrity.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    checked_at: parsed.data.checked_at,
    block: parsed.data.block,
    clean: parsed.data.drifts.length === 0,
    drifts: parsed.data.drifts,
  };
}

export async function ledgerStatus(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<LedgerStatusOutput>> {
  const parsed = ledgerStatusInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const { addresses } = await resolveScope(ctx, input.scope);
  const coverage = await getLedgerStatus(ctx.db, { addresses });

  const wallets: LedgerWalletStatusView[] = coverage.map((w) => {
    const integrity = shapeIntegrity(w.integrity);
    return {
      address: w.address,
      chain_id: w.chainId,
      streams: w.streams.map((s) => ({
        stream: s.stream,
        status: s.status,
        last_processed_block: s.lastProcessedBlock,
        ...(s.lastBlockTime !== undefined ? { last_block_time: s.lastBlockTime } : {}),
        ...(s.anchorBlock !== undefined ? { anchor_block: s.anchorBlock } : {}),
        ...(s.backfillProgress !== undefined ? { backfill_progress: s.backfillProgress } : {}),
        ...(s.lastError !== undefined ? { last_error: s.lastError } : {}),
      })),
      ...(integrity !== undefined ? { integrity } : {}),
      // >50k probe (ADR-008 Q5), surfaced here rather than in ledger_track_wallet's
      // response (async, worker-side). suggests_anchored is the HITL nudge.
      ...(w.estimate !== undefined
        ? { estimate: { tx_count_hint: w.estimate.txCountHint, suggests_anchored: w.estimate.suggestsAnchored } }
        : {}),
    };
  });

  const data: LedgerStatusOutput = { wallets };

  const { coverageRefs, coverageWarnings } = mapCoverage(coverage);

  try {
    ledgerStatusOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `ledger_status produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: coverageRefs, result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: coverageRefs, warnings: coverageWarnings });
}
