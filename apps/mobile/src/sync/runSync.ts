/**
 * Wires everything together and runs one sync pass:
 * HealthKit (on-device) <-> engine <-> Fitbit Web API.
 */

import {
  AppleHealthProvider,
  GoogleHealthProvider,
  SyncEngine,
  type SyncReport,
} from "health-sync";
import { AppleHealthKitBridge } from "../healthkit/bridge.ts";
import { NativeHKClient } from "../healthkit/client.ts";
import { FetchFitbitHttp, FitbitBridge } from "../fitbit/bridge.ts";
import { FitbitTagStore } from "../fitbit/tagStore.ts";
import { fetchUtcOffsetMs, getAccessToken } from "../fitbit/auth.ts";
import { AsyncStorageKV } from "../storage/asyncStorageKV.ts";
import { loadLedger } from "./ledgerStore.ts";

export interface SyncSettings {
  /** Most-trusted device first. */
  devicePriority: string[];
  /** How many days back to sync. */
  lookbackDays: number;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  devicePriority: ["apple-watch", "fitbit", "iphone", "fitbit-scale"],
  lookbackDays: 7,
};

export interface AppSyncResult {
  report: SyncReport;
  /** Records Fitbit's API could not ingest (kept Apple-only). */
  fitbitSkippedWrites: number;
}

export async function runSync(settings: SyncSettings = DEFAULT_SETTINGS): Promise<AppSyncResult> {
  const kv = new AsyncStorageKV();

  const hkBridge = new AppleHealthKitBridge(new NativeHKClient());
  await hkBridge.authorize();

  const tagStore = await FitbitTagStore.load(kv);
  const utcOffsetMs = await fetchUtcOffsetMs();
  const fitbitBridge = new FitbitBridge(
    new FetchFitbitHttp(getAccessToken),
    tagStore,
    utcOffsetMs,
  );

  const engine = new SyncEngine(
    [new AppleHealthProvider(hkBridge), new GoogleHealthProvider(fitbitBridge)],
    {
      dedup: {
        devicePriority: settings.devicePriority,
        stepsStrategy: "priority",
      },
      ledger: await loadLedger(kv),
    },
  );

  const end = Date.now();
  const report = await engine.sync({
    start: end - settings.lookbackDays * 86_400_000,
    end,
  });

  return { report, fitbitSkippedWrites: fitbitBridge.skippedWrites.length };
}
