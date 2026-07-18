/**
 * Real HKClient over @kingstinct/react-native-healthkit (v9 API).
 *
 * This is the only HealthKit file that touches the native module, and the
 * only one that needs a device/simulator to exercise; the bridge and mapping
 * layers above it are pure and unit-tested.
 */

import {
  deleteObjects,
  queryCategorySamples,
  queryQuantitySamples,
  queryWorkoutSamples,
  requestAuthorization,
  saveCategorySample,
  saveQuantitySample,
  WorkoutActivityType,
  type CategorySample,
  type CategoryTypeIdentifier,
  type CategoryValueForIdentifier,
  type ObjectTypeIdentifier,
  type QuantityTypeIdentifier,
  type QueryOptionsWithSortOrder,
  type SampleTypeIdentifierWriteable,
  type SourceRevision,
} from "@kingstinct/react-native-healthkit";
import type { TimeRange } from "health-sync";
import type { HKClient } from "./bridge.ts";
import { QUANTITY_TYPES, WORKOUT_TYPE, type HKSampleDTO } from "./mapping.ts";

// The library's cross-platform stub types queryCategorySamples as 1-arg,
// but the real iOS implementation (CategoryTypeModule.queryCategorySamples)
// accepts (identifier, options) just like the quantity variant.
const queryCategorySamplesWithOptions = queryCategorySamples as unknown as (
  identifier: CategoryTypeIdentifier,
  options?: QueryOptionsWithSortOrder,
) => Promise<readonly CategorySample[]>;

interface QuantityLike {
  unit: string;
  quantity: number;
}

function toMeters(q: QuantityLike | undefined): number | undefined {
  if (!q) return undefined;
  if (q.unit === "km") return q.quantity * 1000;
  if (q.unit === "mi") return q.quantity * 1609.344;
  return q.quantity; // "m"
}

function sourceFields(rev: SourceRevision | undefined) {
  return {
    sourceProductType: rev?.productType ?? undefined,
    sourceName: rev?.source?.name,
    sourceBundleId: rev?.source?.bundleIdentifier,
  };
}

export class NativeHKClient implements HKClient {
  async requestPermissions(read: string[], write: string[]): Promise<void> {
    await requestAuthorization(
      write.filter((t) => t !== WORKOUT_TYPE) as SampleTypeIdentifierWriteable[],
      read as ObjectTypeIdentifier[],
    );
  }

  async queryQuantitySamples(typeIdentifier: string, range: TimeRange): Promise<HKSampleDTO[]> {
    const samples = await queryQuantitySamples(typeIdentifier as QuantityTypeIdentifier, {
      filter: { startDate: new Date(range.start), endDate: new Date(range.end) },
      unit: QUANTITY_TYPES[typeIdentifier]?.unit,
      ascending: true,
      limit: 0,
    });
    return samples.map((s) => ({
      uuid: s.uuid,
      typeIdentifier,
      value: s.quantity,
      unit: s.unit,
      startMs: new Date(s.startDate).getTime(),
      endMs: new Date(s.endDate).getTime(),
      metadata: s.metadata as Record<string, unknown>,
      ...sourceFields(s.sourceRevision),
    }));
  }

  async queryCategorySamples(typeIdentifier: string, range: TimeRange): Promise<HKSampleDTO[]> {
    const samples = await queryCategorySamplesWithOptions(typeIdentifier as CategoryTypeIdentifier, {
      filter: { startDate: new Date(range.start), endDate: new Date(range.end) },
      ascending: true,
      limit: 0,
    });
    return samples.map((s) => ({
      uuid: s.uuid,
      typeIdentifier,
      value: s.value as number,
      startMs: new Date(s.startDate).getTime(),
      endMs: new Date(s.endDate).getTime(),
      metadata: s.metadata as Record<string, unknown>,
      ...sourceFields(s.sourceRevision),
    }));
  }

  async queryWorkouts(range: TimeRange): Promise<HKSampleDTO[]> {
    const workouts = await queryWorkoutSamples({
      filter: { startDate: new Date(range.start), endDate: new Date(range.end) },
      ascending: true,
      limit: 0,
    });
    return workouts.map((w) => ({
      uuid: w.uuid,
      typeIdentifier: WORKOUT_TYPE,
      value: 0,
      startMs: new Date(w.startDate).getTime(),
      endMs: new Date(w.endDate).getTime(),
      metadata: w.metadata as Record<string, unknown> | undefined,
      workoutActivityName: WorkoutActivityType[w.workoutActivityType] ?? "other",
      totalEnergyKcal: w.totalEnergyBurned?.quantity,
      totalDistanceM: toMeters(w.totalDistance),
      ...sourceFields(w.sourceRevision),
    }));
  }

  async save(dto: HKSampleDTO): Promise<void> {
    if (dto.typeIdentifier === WORKOUT_TYPE) {
      // Companion apps rarely save HKWorkouts; the other platform's workout
      // arrives as its energy/distance samples instead.
      return;
    }
    const metadata = (dto.metadata ?? {}) as Record<string, string>;
    if (QUANTITY_TYPES[dto.typeIdentifier]) {
      await saveQuantitySample(
        dto.typeIdentifier as QuantityTypeIdentifier,
        dto.unit!,
        dto.value,
        new Date(dto.startMs),
        new Date(dto.endMs),
        metadata,
      );
      return;
    }
    await saveCategorySample(
      dto.typeIdentifier as CategoryTypeIdentifier,
      dto.value as CategoryValueForIdentifier,
      new Date(dto.startMs),
      new Date(dto.endMs),
      metadata,
    );
  }

  async deleteByMetadata(typeIdentifier: string, key: string, values: string[]): Promise<void> {
    if (typeIdentifier === WORKOUT_TYPE) return;
    // Fetch our tagged samples (HealthKit only lets an app delete its own
    // writes anyway), match the tag value in JS, delete by uuid.
    const wanted = new Set(values);
    const filter = { withMetadataKey: key } as const;
    const samples = QUANTITY_TYPES[typeIdentifier]
      ? await queryQuantitySamples(typeIdentifier as QuantityTypeIdentifier, { filter, limit: 0 })
      : await queryCategorySamplesWithOptions(typeIdentifier as CategoryTypeIdentifier, { filter, limit: 0 });
    const uuids = samples
      .filter((s) => wanted.has((s.metadata as Record<string, unknown>)?.[key] as string))
      .map((s) => s.uuid);
    if (uuids.length > 0) {
      await deleteObjects(typeIdentifier as ObjectTypeIdentifier, { uuids });
    }
  }
}
