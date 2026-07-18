/**
 * Automatic background sync via BGTaskScheduler (expo-background-task).
 *
 * iOS decides the exact cadence (typically a few times a day, more often for
 * apps used regularly). Each wake runs one full sync pass; failures are
 * reported to the scheduler so iOS retries later. HealthKit data is
 * unavailable before the first unlock after a reboot — that surfaces as a
 * failed run and simply retries.
 *
 * NOTE: this module must be imported from index.ts (global scope) so the
 * task is defined before the app finishes launching.
 */

import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { isConnected } from "../fitbit/auth.ts";
import { runSync } from "./runSync.ts";

export const BACKGROUND_SYNC_TASK = "health-sync-background";

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    if (!(await isConnected())) {
      // Not set up yet — nothing to do, don't count as a failure.
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    await runSync();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Ask iOS to run the sync periodically. Idempotent. */
export async function enableBackgroundSync(): Promise<void> {
  await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, {
    minimumInterval: 6 * 60, // minutes; a floor, not a schedule — iOS decides
  });
}
