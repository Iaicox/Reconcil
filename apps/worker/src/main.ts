/**
 * Worker host (ADR-008): BullMQ processors for backfill, live tail, prices,
 * token resolve, integrity checks, exports. All provider I/O, rate limiting,
 * and retries live here — the server never ingests (00-overview §2).
 *
 * Queue processors arrive with packages/ingestion (weeks 1–3); until then
 * this process only proves the container wiring stays up.
 */
const HEARTBEAT_MS = 60_000;

console.log('[worker] started; queue processors are not wired yet (ADR-008)');

const heartbeat = setInterval(() => {
  console.log('[worker] heartbeat');
}, HEARTBEAT_MS);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(heartbeat);
    console.log(`[worker] ${signal} received, shutting down`);
    process.exit(0);
  });
}
