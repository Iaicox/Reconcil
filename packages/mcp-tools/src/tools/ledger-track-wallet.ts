/**
 * `ledger_track_wallet` (contract §6.2) — the onboarding write tool. Creates the
 * tenant's wallet row (idempotent on `UNIQUE(tenant_id, address)`) and seeds
 * ingestion checkpoints per (chain, stream); a worker scanner turns those into
 * jobs, so this tool never imports `ingestion`/BullMQ (dependency-cruiser
 * boundary). `enqueued` carries the deterministic job id the scanner will use, so
 * the response and the eventual BullMQ job line up. Checkpoints are GLOBAL (shared
 * across tenants tracking the same address), and `onConflictDoNothing` never
 * resets an in-progress cursor — so an anchored request only takes effect for a
 * freshly-created checkpoint (an already-tracked address is not downgraded).
 *
 * mode='full' → `queued` (full-history backfill); mode='anchored' → `anchoring`
 * with `anchor_from`, seeding an opening_balance baseline (ADR-008). The >50k
 * probe is asynchronous — it runs worker-side and surfaces via `ledger_status`
 * (`suggests_anchored`), never in this tool's response (boundary + 02-mcp-contracts).
 */
import {
  anchorJobId, backfillJobId, chains, ledgerTrackWalletInput, ledgerTrackWalletOutput,
  type LedgerTrackWalletOutput,
} from '@pet-crypto/core';
import { ingestionCheckpoints, wallets } from '@pet-crypto/db';
import { and, eq } from 'drizzle-orm';

import type { ToolContext } from '../context.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { resolveClientId } from '../scope.js';
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

  // The schema (F4) already guarantees anchored_from is a real, past date here.
  const anchored = input.mode === 'anchored';
  const address = input.address.toLowerCase();
  const enabled = new Set(chains.map((c) => c.chainId));
  const requested = input.chains ?? chains.map((c) => c.chainId);
  for (const c of requested) {
    if (!enabled.has(c)) throw new ToolError('INVALID_INPUT', `unknown chain id: ${String(c)}`);
  }
  // Config order, de-duped.
  const targetChains = chains.map((c) => c.chainId).filter((c) => requested.includes(c));

  // Reject a client_id that isn't the tenant's own before any write (ADR-006).
  const clientId = await resolveClientId(ctx, input.client_id);

  // Idempotent wallet upsert; a re-track returns the existing id (never a duplicate).
  await ctx.db
    .insert(wallets)
    .values({
      tenantId: ctx.tenantId,
      address,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(clientId !== null ? { clientId } : {}),
    })
    .onConflictDoNothing({ target: [wallets.tenantId, wallets.address] });
  const [w] = await ctx.db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.tenantId, ctx.tenantId), eq(wallets.address, address)))
    .limit(1);
  if (!w) throw new ToolError('INTERNAL', 'wallet upsert did not persist');

  // Seed checkpoints and report only the streams THIS call actually created.
  // Checkpoints are global; a stream already live/backfilling is a no-op insert the
  // scanner never enqueues, so `.returning()` keeps `enqueued` truthful. Anchored
  // streams enter `anchoring` with the requested date; the worker resolves it to a
  // block and writes the opening_balance baseline (ADR-008).
  const seed = anchored
    ? { status: 'anchoring' as const, anchorFrom: input.anchored_from }
    : { status: 'queued' as const };
  const jobIdFor = (chainId: number, stream: 'native' | 'erc20'): string =>
    anchored ? anchorJobId(chainId, address, stream) : backfillJobId(chainId, address, stream);

  const enqueued: LedgerTrackWalletOutput['enqueued'] = [];
  for (const chainId of targetChains) {
    for (const stream of STREAMS) {
      const inserted = await ctx.db
        .insert(ingestionCheckpoints)
        .values({ chainId, address, stream, ...seed })
        .onConflictDoNothing()
        .returning({ stream: ingestionCheckpoints.stream });
      if (inserted.length > 0) {
        enqueued.push({ chain_id: chainId, stream, job_id: jobIdFor(chainId, stream) });
      }
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
