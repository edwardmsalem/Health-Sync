/**
 * Wires everything together and runs one sync pass with whatever is
 * connected: HealthKit (always) <-> engine <-> Fitbit Web API (if signed in)
 * + Nightscout/AAPS as a read-only source (if configured).
 *
 * Apple Health is the hub: it is the only platform that accepts every data
 * type, so everything converges there.
 */

import {
  AppleHealthProvider,
  GoogleHealthProvider,
  SyncEngine,
  type HealthProvider,
  type SyncReport,
} from "health-sync";
import { AppleHealthKitBridge } from "../healthkit/bridge.ts";
import { NativeHKClient } from "../healthkit/client.ts";
import { FetchFitbitHttp, FitbitBridge } from "../fitbit/bridge.ts";
import { FitbitTagStore } from "../fitbit/tagStore.ts";
import { fetchUtcOffsetMs, getAccessToken, isConnected } from "../fitbit/auth.ts";
import { getNightscoutConfig } from "../nightscout/config.ts";
import { NightscoutProvider } from "../nightscout/provider.ts";
import { AsyncStorageKV } from "../storage/asyncStorageKV.ts";
import { loadLedger } from "./ledgerStore.ts";
import { noteSyncSucceeded } from "./reminder.ts";
import { withSyncLock } from "./lock.ts";

export interface SyncSettings {
  /** Most-trusted source first. */
  devicePriority: string[];
  /** How many days back to sync. */
  lookbackDays: number;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  // Manual entries first — a human logging their under-desk treadmill walk
  // beats a wrist device that barely moved. Then wearables, then phone.
  devicePriority: [
    "manual-entry",
    "apple-watch",
    "garmin",
    "fitbit",
    "iphone",
    "fitbit-scale",
    "aaps",
  ],
  lookbackDays: 7,
};

export interface AppSyncResult {
  report: SyncReport;
  /** Records Fitbit's API could not ingest (kept Apple-only). */
  fitbitSkippedWrites: number;
  /** Which sources participated in this run. */
  connected: { fitbit: boolean; nightscout: boolean };
}

export interface SyncStack {
  engine: SyncEngine;
  fitbitBridge: FitbitBridge | null;
  connected: { fitbit: boolean; nightscout: boolean };
}

/**
 * Assemble the engine over whatever sources are connected. Split out from
 * runSync so a history backfill can reuse one stack across many chunks
 * instead of re-authorizing HealthKit and re-fetching the profile each time.
 */
export async function buildSyncStack(
  settings: SyncSettings = DEFAULT_SETTINGS,
): Promise<SyncStack> {
  const kv = new AsyncStorageKV();

  const hkBridge = new AppleHealthKitBridge(new NativeHKClient());
  await hkBridge.authorize();

  const providers: HealthProvider[] = [new AppleHealthProvider(hkBridge)];

  let fitbitBridge: FitbitBridge | null = null;
  if (await isConnected()) {
    const tagStore = await FitbitTagStore.load(kv);
    const utcOffsetMs = await fetchUtcOffsetMs();
    fitbitBridge = new FitbitBridge(new FetchFitbitHttp(getAccessToken), tagStore, utcOffsetMs);
    providers.push(new GoogleHealthProvider(fitbitBridge));
  }

  const nightscoutConfig = await getNightscoutConfig();
  if (nightscoutConfig) {
    providers.push(new NightscoutProvider(nightscoutConfig));
  }

  if (providers.length < 2) {
    throw new Error(
      "Nothing to sync with yet — connect Fitbit and/or configure Nightscout first.",
    );
  }

  const engine = new SyncEngine(providers, {
    dedup: {
      devicePriority: settings.devicePriority,
      stepsStrategy: "priority",
    },
    ledger: await loadLedger(kv),
  });

  return {
    engine,
    fitbitBridge,
    connected: { fitbit: fitbitBridge !== null, nightscout: nightscoutConfig !== null },
  };
}

/**
 * One sync pass. Serialized: if a pass is already running (background task,
 * a HealthKit observer, the Sync button), this awaits it instead of starting
 * a second one. Two overlapping passes would each see the same data as
 * missing and both write it.
 */
export async function runSync(
  settings: SyncSettings = DEFAULT_SETTINGS,
): Promise<AppSyncResult | null> {
  const { result } = await withSyncLock(() => runSyncUnlocked(settings));
  return result;
}

async function runSyncUnlocked(settings: SyncSettings): Promise<AppSyncResult> {
  const stack = await buildSyncStack(settings);

  const end = Date.now();
  const report = await stack.engine.sync({
    start: end - settings.lookbackDays * 86_400_000,
    end,
  });

  // Successful pass: push the "gone quiet" reminder further out.
  await noteSyncSucceeded(new AsyncStorageKV(), end);

  return {
    report,
    fitbitSkippedWrites: stack.fitbitBridge?.skippedWrites.length ?? 0,
    connected: stack.connected,
  };
}
