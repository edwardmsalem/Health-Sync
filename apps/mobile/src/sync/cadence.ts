/**
 * Pure pacing rules for how often sync may run. No Expo/native imports, so
 * this is unit-testable off-device.
 */

/** Don't sync more often than this, however many observers fire. */
export const MIN_SYNC_GAP_MS = 20 * 60_000;

/** Whether enough time has passed since the last successful sync. */
export function shouldSyncNow(
  lastSyncAt: number | null,
  nowMs: number,
  minGapMs = MIN_SYNC_GAP_MS,
): boolean {
  if (lastSyncAt === null) return true;
  return nowMs - lastSyncAt >= minGapMs;
}
