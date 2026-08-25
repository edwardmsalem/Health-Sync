/**
 * Keep sync ticking through the day using HealthKit background delivery.
 *
 * iOS gives no fixed interval to an app like this. BGTaskScheduler is
 * opportunistic — a few times a day, when iOS feels like it, and not at all
 * after a force-quit. HealthKit background delivery is the mechanism Apple
 * actually intends for health apps: register an observer on a data type and
 * iOS launches the app (in the background) whenever new samples of that type
 * land, capped at hourly for most types.
 *
 * The types watched here are ones a worn device writes all day, so in
 * practice the app is woken through the day rather than a few times total.
 * Each wake runs the full sync, which also pulls Nightscout — HealthKit
 * cannot observe Nightscout, so its writes ride along on these wakeups.
 *
 * A minimum gap between runs keeps a burst of writes from causing a burst of
 * syncs; the requirement was "often enough, not too often".
 */

import {
  enableBackgroundDelivery,
  subscribeToChanges,
  UpdateFrequency,
  type ObjectTypeIdentifier,
  type SampleTypeIdentifier,
} from "@kingstinct/react-native-healthkit";
import { shouldSyncNow } from "./cadence.ts";
import type { KV } from "../storage/kv.ts";
import { AsyncStorageKV } from "../storage/asyncStorageKV.ts";
import { getLastSyncAt } from "./reminder.ts";
import { runSync } from "./runSync.ts";

/**
 * Types a worn device writes throughout the day, so an observer on them acts
 * as a general-purpose heartbeat. Deliberately few: each one is a separate
 * wake reason, and they all trigger the same full sync.
 */
const WATCHED_TYPES = [
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierHeartRate",
] as const;

let started = false;

/**
 * Register background delivery + observers. Idempotent and safe to call on
 * every launch; never throws, since failing here must not break the app.
 */
export async function startHealthObservers(kv: KV = new AsyncStorageKV()): Promise<void> {
  if (started) return;
  started = true;

  for (const type of WATCHED_TYPES) {
    try {
      // Hourly is the floor iOS enforces for most quantity types; asking for
      // immediate on them is silently downgraded.
      await enableBackgroundDelivery(type as ObjectTypeIdentifier, UpdateFrequency.hourly);
      subscribeToChanges(type as SampleTypeIdentifier, () => {
        void onHealthDataChanged(kv);
      });
    } catch {
      // A type we cannot observe (or missing authorization) shouldn't stop
      // the others being registered.
    }
  }
}

async function onHealthDataChanged(kv: KV): Promise<void> {
  try {
    if (!shouldSyncNow(await getLastSyncAt(kv), Date.now())) return;
    await runSync();
  } catch {
    // Woken in the background with no chance to report; the next wake retries.
  }
}
