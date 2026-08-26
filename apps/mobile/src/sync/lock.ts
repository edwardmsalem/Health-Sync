/**
 * Single-flight guard around sync.
 *
 * There are three entry points — the Sync button, the BGTaskScheduler task,
 * and the HealthKit observers (one per watched type) — and nothing stopped
 * them overlapping. A sync reads every platform, decides what is missing,
 * then writes. Two runs overlapping means both read the same "missing"
 * state before either writes, so both write it: two identical samples, same
 * value, same timestamp to the second. Two observers firing together is
 * enough, and the timestamp guard could not prevent it because it is only
 * updated after a run finishes.
 *
 * So concurrent callers share one in-flight run rather than starting another.
 */

let inFlight: Promise<unknown> | null = null;

/**
 * Run `fn` unless a run is already in progress, in which case await that one.
 * Returns whether this call started the run, alongside the result.
 */
export async function withSyncLock<T>(
  fn: () => Promise<T>,
): Promise<{ ran: boolean; result: T | null }> {
  if (inFlight) {
    await inFlight.catch(() => {});
    return { ran: false, result: null };
  }
  const promise = (async () => fn())();
  inFlight = promise;
  try {
    const result = await promise;
    return { ran: true, result };
  } finally {
    inFlight = null;
  }
}

/** True while a sync is running. */
export function isSyncing(): boolean {
  return inFlight !== null;
}

/** Testing only. */
export function __resetSyncLock(): void {
  inFlight = null;
}
