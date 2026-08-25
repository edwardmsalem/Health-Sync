/**
 * "Sync has gone quiet" reminder — a dead man's switch, entirely on-device.
 *
 * iOS runs the background sync only while the app is merely backgrounded. If
 * the app is FORCE-QUIT from the app switcher, iOS stops scheduling its
 * background tasks until it is opened again; the same silence follows from
 * Background App Refresh being switched off or Low Power Mode. In all of
 * those cases the app cannot notice and complain, because it is not running.
 *
 * So the alarm is set in advance and pushed back on every success: each sync
 * reschedules a local notification for STALE_AFTER_DAYS ahead. While syncing
 * keeps working the notification keeps moving and never fires. The moment
 * syncing stops for any reason, the last one left standing fires and asks for
 * the app to be opened. iOS holds scheduled local notifications itself, so
 * this still fires after a force-quit — which is exactly the case that needs
 * catching. No server, no push certificates, no account.
 */

import * as Notifications from "expo-notifications";
import type { KV } from "../storage/kv.ts";

const LAST_SYNC_KEY = "last-sync-at";
const REMINDER_ID_KEY = "stale-reminder-id";

/** Silence this long and the app asks to be opened. */
export const STALE_AFTER_DAYS = 3;
const DAY_MS = 86_400_000;

export async function requestNotificationPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;
  if (!existing.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

export async function getLastSyncAt(kv: KV): Promise<number | null> {
  const raw = await kv.get(LAST_SYNC_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Record a successful sync and push the reminder back. Never throws: a
 * notification problem must not fail an otherwise good sync.
 */
export async function noteSyncSucceeded(kv: KV, nowMs = Date.now()): Promise<void> {
  try {
    await kv.set(LAST_SYNC_KEY, String(nowMs));

    const previous = await kv.get(REMINDER_ID_KEY);
    if (previous) {
      await Notifications.cancelScheduledNotificationAsync(previous).catch(() => {});
    }

    if (!(await Notifications.getPermissionsAsync()).granted) return;

    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: "Health Sync has gone quiet",
        body: `No sync in ${STALE_AFTER_DAYS} days. Open the app to catch up — iOS stops background syncing if the app was force-quit.`,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: (STALE_AFTER_DAYS * DAY_MS) / 1000,
        repeats: false,
      },
    });
    await kv.set(REMINDER_ID_KEY, id);
  } catch {
    // Best effort only.
  }
}

/** Human-readable staleness, for the UI. */
export function describeLastSync(lastSyncAt: number | null, nowMs = Date.now()): string {
  if (lastSyncAt === null) return "Never synced";
  const mins = Math.floor((nowMs - lastSyncAt) / 60_000);
  if (mins < 1) return "Synced just now";
  if (mins < 60) return `Synced ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Synced ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `Synced ${days} day${days === 1 ? "" : "s"} ago`;
}

/** True once silence has passed the threshold the reminder fires on. */
export function isStale(lastSyncAt: number | null, nowMs = Date.now()): boolean {
  if (lastSyncAt === null) return false;
  return nowMs - lastSyncAt > STALE_AFTER_DAYS * DAY_MS;
}
