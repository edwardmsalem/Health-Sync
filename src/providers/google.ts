/**
 * Google Health provider.
 *
 * Google's current health platform is Health Connect (on-device, Android) —
 * the Google Fit REST API is deprecated. Like HealthKit, Health Connect is
 * only reachable from an Android app, so this adapter talks to an injected
 * `HealthConnectBridge`:
 *
 *   - reads map to HealthConnectClient.readRecords(StepsRecord /
 *     SleepSessionRecord / ExerciseSessionRecord / HeartRateRecord);
 *   - writes map to insertRecords with `clientRecordId` set to the record's
 *     externalId (Health Connect's native external-id mechanism);
 *   - deletes map to deleteRecords(clientRecordIds).
 *
 * If your Google-side data comes from a Fitbit device, implement the same
 * bridge over the Fitbit Web API instead (activities/steps intraday,
 * sleep logs); keep the Fitbit log-id -> externalId mapping in the bridge.
 */

import type { HealthProvider } from "./provider.js";
import type { HealthRecord, TimeRange } from "../types.js";

export interface HealthConnectBridge {
  readRecords(range: TimeRange): Promise<HealthRecord[]>;
  insertRecords(records: HealthRecord[]): Promise<void>;
  deleteRecordsByClientIds(clientRecordIds: string[]): Promise<void>;
}

export class GoogleHealthProvider implements HealthProvider {
  readonly platform = "google" as const;

  constructor(private readonly bridge: HealthConnectBridge) {}

  read(range: TimeRange): Promise<HealthRecord[]> {
    return this.bridge.readRecords(range);
  }

  write(records: HealthRecord[]): Promise<void> {
    return this.bridge.insertRecords(records);
  }

  deleteByExternalIds(externalIds: string[]): Promise<void> {
    return this.bridge.deleteRecordsByClientIds(externalIds);
  }
}
