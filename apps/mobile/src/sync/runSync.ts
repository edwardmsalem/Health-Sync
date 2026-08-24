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

export async function runSync(settings: SyncSettings = DEFAULT_SETTINGS): Promise<AppSyncResult> {
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

  const end = Date.now();
  const report = await engine.sync({
    start: end - settings.lookbackDays * 86_400_000,
    end,
  });

  return {
    report,
    fitbitSkippedWrites: fitbitBridge?.skippedWrites.length ?? 0,
    connected: { fitbit: fitbitBridge !== null, nightscout: nightscoutConfig !== null },
  };
}
