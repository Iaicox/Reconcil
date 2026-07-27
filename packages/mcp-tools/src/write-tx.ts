/**
 * The write-tool atomicity helper (invariant C2). Every write tool runs its domain
 * mutation and its `tool_calls` audit row in ONE transaction, so a committed write can
 * never lack its audit record: `persistToolCall` runs on the same transaction handle as
 * the mutation, and any failure (a persist error, an output-contract violation, a crash)
 * rolls both back together. Without this the two committed separately and a crash in the
 * window between them left an un-audited mutation — a silent provenance hole (P1/P2).
 *
 * The body does the mutation on the tx-scoped `TxContext` and returns the validated output
 * `data` plus the envelope's non-id parts (coverage, refs, price/fx, warnings); the helper
 * persists (result digest over `data`) and builds the citation envelope, all in-transaction.
 * `serializable` opts a tool into a SERIALIZABLE transaction with a bounded retry on a
 * serialization failure / deadlock (recon_confirm_match / recon_reject_match enforce
 * cross-row matching invariants and need it); the default is read-committed, single-attempt.
 */
import { ulid } from './ulid.js';
import type { ToolContext, TxContext } from './context.js';
import { buildEnvelope, type EnvelopeParts, type ToolEnvelope } from './envelope.js';
import { persistToolCall } from './tool-calls.js';

/** Retries for a SERIALIZABLE serialization failure (40001) / deadlock (40P01). */
const MAX_TX_ATTEMPTS = 3;

/** A Postgres serialization failure / deadlock — safe to retry the whole transaction. */
function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } })?.code
    ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === '40001' || code === '40P01';
}

/**
 * Run `fn`, retrying only on a Postgres serialization failure / deadlock, up to `max`
 * attempts. Any other error (or the final serialization failure) is rethrown. Pure — the
 * transaction boundary is the caller's; this is just the retry policy.
 */
export async function withRetry<T>(fn: () => Promise<T>, max = MAX_TX_ATTEMPTS): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < max && isRetryable(err)) continue;
      throw err;
    }
  }
}

/** What a write tool's body produces: the output data + the envelope's non-id parts. */
export interface WriteToolResult<T> {
  data: T;
  /** Coverage (usually `[]` for writes) plus any event/price/fx refs and warnings. */
  envelope: Omit<EnvelopeParts, 'toolCallId'>;
}

export interface WriteToolSpec<T> {
  toolName: string;
  /** Persisted as the audit `args` (redact bulky/raw fields before passing). */
  args: Record<string, unknown>;
  /** Pre-minted id when the mutation must cite it (export manifests); else auto-minted. */
  toolCallId?: string;
  /** Opt into SERIALIZABLE + serialization-failure retry (cross-row invariant enforcement). */
  isolation?: 'serializable';
  /** The mutation, on a tx-scoped ctx. Its throw rolls back the whole transaction. */
  body: (txCtx: TxContext, toolCallId: string) => Promise<WriteToolResult<T>>;
}

/**
 * Execute a write tool atomically: open one transaction, run `spec.body` on it, persist the
 * tool_call in the same transaction, and return the citation envelope. `ctx.db` is the real
 * `Db` (a top-level tool handler always holds one), so the isolation level can be set here.
 */
export async function runWriteTool<T>(ctx: ToolContext, spec: WriteToolSpec<T>): Promise<ToolEnvelope<T>> {
  const id = spec.toolCallId ?? ulid();

  const attempt = (): Promise<ToolEnvelope<T>> =>
    ctx.db.transaction(
      async (tx): Promise<ToolEnvelope<T>> => {
        const txCtx: TxContext = { db: tx, tenantId: ctx.tenantId };
        const { data, envelope } = await spec.body(txCtx, id);
        await persistToolCall(txCtx, {
          id,
          toolName: spec.toolName,
          args: spec.args,
          coverage: envelope.coverage,
          result: data,
        });
        return buildEnvelope(data, { toolCallId: id, ...envelope });
      },
      spec.isolation === 'serializable' ? { isolationLevel: 'serializable' } : undefined,
    );

  return spec.isolation === 'serializable' ? withRetry(attempt) : attempt();
}
