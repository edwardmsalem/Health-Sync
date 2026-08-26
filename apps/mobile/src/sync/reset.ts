/**
 * Clear everything the app remembers about past syncs.
 *
 * The ledger records which fingerprints have been written to which platform,
 * so a sync can skip work it already did. That is an optimisation, but it
 * becomes a trap when records are deleted OUTSIDE the app — using Health's
 * "Delete All Data from Health Sync", say. The ledger still claims those
 * records exist, so the engine declines to write them again and the data is
 * gone for good.
 *
 * Resetting makes the next sync treat the platforms as the source of truth
 * and rebuild from scratch. It deletes nothing; it only forgets.
 */

import type { KV } from "../storage/kv.ts";

/** Every key holding remembered sync state. */
export const SYNC_STATE_KEYS = [
  "sync-ledger",
  "last-sync-at",
  "stale-reminder-id",
  "fitbit-tag-store",
  "backfill-state",
] as const;

export async function resetSyncState(kv: KV): Promise<void> {
  for (const key of SYNC_STATE_KEYS) {
    await kv.set(key, "");
  }
}
