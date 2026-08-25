/**
 * Implements the engine's HealthKitBridge over a narrow HKClient interface.
 * The real HKClient (client.ts) wraps the native module; tests inject a fake.
 */

import type { HealthKitBridge, HealthRecord, TimeRange } from "health-sync";
import {
  HKSampleDTO,
  HK_EXTERNAL_ID_KEY,
  QUANTITY_TYPES,
  READ_ONLY_QUANTITY_TYPES,
  SLEEP_TYPE,
  WORKOUT_TYPE,
  categoryToSleepSessions,
  quantityToRecords,
  recordToDTOs,
  workoutsToRecords,
} from "./mapping.ts";

/** The only operations we need from the native HealthKit module. */
export interface HKClient {
  requestPermissions(read: string[], write: string[]): Promise<void>;
  queryQuantitySamples(typeIdentifier: string, range: TimeRange): Promise<HKSampleDTO[]>;
  queryCategorySamples(typeIdentifier: string, range: TimeRange): Promise<HKSampleDTO[]>;
  queryWorkouts(range: TimeRange): Promise<HKSampleDTO[]>;
  save(dto: HKSampleDTO): Promise<void>;
  /** Delete samples of a type whose metadata[HK_EXTERNAL_ID_KEY] matches. */
  deleteByMetadata(typeIdentifier: string, key: string, values: string[]): Promise<void>;
}

const ALL_TYPES = [...Object.keys(QUANTITY_TYPES), SLEEP_TYPE, WORKOUT_TYPE];

/**
 * Types we ask to WRITE. Workouts are saved by their owning app, and
 * HealthKit-derived quantities (exercise time and friends) reject write
 * authorization outright, taking the whole request down with them.
 */
const WRITABLE_TYPES = ALL_TYPES.filter(
  (t) => t !== WORKOUT_TYPE && !READ_ONLY_QUANTITY_TYPES.has(t),
);

export class AppleHealthKitBridge implements HealthKitBridge {
  constructor(private readonly client: HKClient) {}

  async authorize(): Promise<void> {
    await this.client.requestPermissions(ALL_TYPES, WRITABLE_TYPES);
  }

  async querySamples(range: TimeRange): Promise<HealthRecord[]> {
    const quantityDtos = (
      await Promise.all(
        Object.keys(QUANTITY_TYPES).map((t) =>
          this.client.queryQuantitySamples(t, range),
        ),
      )
    ).flat();
    const sleepDtos = await this.client.queryCategorySamples(SLEEP_TYPE, range);
    const workoutDtos = await this.client.queryWorkouts(range);
    return [
      ...quantityToRecords(quantityDtos),
      ...categoryToSleepSessions(sleepDtos),
      ...workoutsToRecords(workoutDtos),
    ];
  }

  async saveSamples(records: HealthRecord[]): Promise<void> {
    for (const record of records) {
      for (const dto of recordToDTOs(record)) {
        await this.client.save(dto);
      }
    }
  }

  async deleteSamplesByExternalIds(externalIds: string[]): Promise<void> {
    if (externalIds.length === 0) return;
    for (const type of ALL_TYPES) {
      await this.client.deleteByMetadata(type, HK_EXTERNAL_ID_KEY, externalIds);
    }
  }
}
