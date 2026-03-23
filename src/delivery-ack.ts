/**
 * Per-run IPC delivery tracking.
 *
 * When a container agent sends a message via IPC (`send_message`), the IPC
 * watcher records a delivery acknowledgement keyed by `runId`.
 * `processGroupMessages` checks this after container errors to decide whether
 * cursor rollback is safe (i.e. the user already received a response).
 *
 * The in-memory Map is the fast path; durable persistence happens in
 * `run_ledger.ipc_delivered` (managed by the caller).
 */

const deliveredRuns = new Map<string, number>();

/** Max age (ms) before a stale delivery record is evicted. */
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/** Evict entries older than MAX_AGE_MS to prevent unbounded growth. */
function evictStale(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [runId, ts] of deliveredRuns) {
    if (ts < cutoff) {
      deliveredRuns.delete(runId);
    }
  }
}

/** Record that a message was successfully delivered for a given run. */
export function recordDeliveryAck(runId: string): void {
  deliveredRuns.set(runId, Date.now());
  // Lazy eviction: clean up stale entries when the map grows large
  if (deliveredRuns.size > 100) {
    evictStale();
  }
}

/** Check whether a delivery was recorded for a given run. */
export function wasDelivered(runId: string): boolean {
  return deliveredRuns.has(runId);
}

/** Remove a delivery record after it has been consumed. */
export function clearDeliveryAck(runId: string): void {
  deliveredRuns.delete(runId);
}

/** Visible for testing only — reset all entries. */
export function _resetForTest(): void {
  deliveredRuns.clear();
}
