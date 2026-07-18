/**
 * Apple Health provider.
 *
 * HealthKit has no cloud API — it is only accessible on-device from an iOS
 * app. This adapter therefore talks to an injected `HealthKitBridge`, which a
 * companion iOS app (Swift/React Native/Capacitor) implements over HealthKit:
 *
 *   - reads map to HKSampleQuery over HKQuantityTypeIdentifierStepCount,
 *     HKCategoryTypeIdentifierSleepAnalysis, HKWorkoutType, heartRate;
 *   - writes map to HKHealthStore.save(...) with
 *     `HKMetadataKeySyncIdentifier` / metadata["externalId"] set to the
 *     record's externalId (this is what makes sync-authored records
 *     recognizable and deletable later);
 *   - deletes map to HKHealthStore.delete(objectsWithMetadata...).
 *
 * The normalized record model keeps this file free of any platform SDK
 * dependency, so the core engine runs anywhere (device, server, tests).
 */

import type { HealthProvider } from "./provider.js";
import type { HealthRecord, TimeRange } from "../types.js";

export interface HealthKitBridge {
  querySamples(range: TimeRange): Promise<HealthRecord[]>;
  saveSamples(records: HealthRecord[]): Promise<void>;
  deleteSamplesByExternalIds(externalIds: string[]): Promise<void>;
}

export class AppleHealthProvider implements HealthProvider {
  readonly platform = "apple" as const;

  constructor(private readonly bridge: HealthKitBridge) {}

  read(range: TimeRange): Promise<HealthRecord[]> {
    return this.bridge.querySamples(range);
  }

  write(records: HealthRecord[]): Promise<void> {
    return this.bridge.saveSamples(records);
  }

  deleteByExternalIds(externalIds: string[]): Promise<void> {
    return this.bridge.deleteSamplesByExternalIds(externalIds);
  }
}
