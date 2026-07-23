/**
 * `ledger_track_wallet` (contract §6.2) — the onboarding write tool. Creates the
 * tenant's wallet row (idempotent on `UNIQUE(tenant_id, address)`) and seeds
 * `queued` ingestion checkpoints per (chain, stream); a worker scanner turns
 * those into backfill jobs, so this tool never imports `ingestion`/BullMQ
 * (dependency-cruiser boundary). `enqueued` carries the deterministic job id the
 * scanner will use, so the response and the eventual BullMQ job line up.
 * Checkpoints are GLOBAL (shared across tenants tracking the same address), and
 * `onConflictDoNothing` never resets an in-progress cursor to `queued`.
 * Anchored onboarding + the whale probe are a follow-up slice (ADR-008).
 */
import {
  backfillJobId, chains, ledgerTrackWalletInput, ledgerTrackWalletOutput,
  type LedgerTrackWalletOutput,
} from '@pet-crypto/core';
import { ingestionCheckpoints, wallets } from '@pet-crypto/db';
import { and, eq } from 'drizzle-orm';

import type { ToolContext } from '../context.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'ledger_track_wallet';

const STREAMS = ['native', 'erc20'] as const;

export async function ledgerTrackWallet(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<LedgerTrackWalletOutput>> {
  const parsed = ledgerTrackWalletInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  // Anchored onboarding writes an opening_balance baseline; the ingestion path
  // for it is deferred (ADR-008 / 03-ingestion.md), so reject rather than
  // silently backfilling full history under an anchored request.
  if (input.mode === 'anchored') {
    throw new ToolError('INVALID_INPUT', "mode='anchored' is not yet supported", 'track with the default full-history mode');
  }

  const address = input.address.toLowerCase();
  const enabled = new Set(chains.map((c) => c.chainId));
  const requested = input.chains ?? chains.map((c) => c.chainId);
  for (const c of requested) {
    if (!enabled.has(c)) throw new ToolError('INVALID_INPUT', `unknown chain id: ${String(c)}`);
  }
  // Config order, de-duped.
  const targetChains = chains.map((c) => c.chainId).filter((c) => requested.includes(c));

  // Idempotent wallet upsert; a re-track returns the existing id (never a duplicate).
  await ctx.db
    .insert(wallets)
    .values({
      tenantId: ctx.tenantId,
      address,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.client_id !== undefined ? { clientId: input.client_id } : {}),
    })
    .onConflictDoNothing({ target: [wallets.tenantId, wallets.address] });
  const [w] = await ctx.db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.tenantId, ctx.tenantId), eq(wallets.address, address)))
    .limit(1);
  if (!w) throw new ToolError('INTERNAL', 'wallet upsert did not persist');

  const enqueued: LedgerTrackWalletOutput['enqueued'] = [];
  for (const chainId of targetChains) {
    for (const stream of STREAMS) {
      await ctx.db
        .insert(ingestionCheckpoints)
        .values({ chainId, address, stream, status: 'queued' })
        .onConflictDoNothing();
      enqueued.push({ chain_id: chainId, stream, job_id: backfillJobId(chainId, address, stream) });
    }
  }

  const data: LedgerTrackWalletOutput = { wallet_id: w.id, enqueued };

  try {
    ledgerTrackWalletOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `ledger_track_wallet produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: [], result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: [] });
}
