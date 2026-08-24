/**
 * Pure mapping between engine records and HealthKit sample shapes.
 * No native imports — everything here is unit-testable off-device.
 */

import type {
  CumulativeMetric,
  HealthRecord,
  PointMetric,
  SleepSession,
  SleepStage,
  SleepStageInterval,
  SourceRef,
  StepsSample,
} from "health-sync";

/** Custom HealthKit metadata key carrying the engine's externalId tag. */
export const HK_EXTERNAL_ID_KEY = "healthSyncExternalId";

/** Neutral sample shape produced/consumed by the native HealthKit client. */
export interface HKSampleDTO {
  uuid?: string;
  /** HK type identifier, e.g. "HKQuantityTypeIdentifierStepCount". */
  typeIdentifier: string;
  /** Quantity value (quantity samples) or category value (category samples). */
  value: number;
  unit?: string;
  startMs: number;
  endMs: number;
  /** e.g. "Watch7,2", "iPhone16,1" — from the sample's sourceRevision. */
  sourceProductType?: string;
  sourceName?: string;
  sourceBundleId?: string;
  metadata?: Record<string, unknown>;
  /** Workout-only. */
  workoutActivityName?: string;
  totalEnergyKcal?: number;
  totalDistanceM?: number;
}

/** Quantity metrics we sync, in both directions. */
export const QUANTITY_TYPES: Record<string, { metric: CumulativeMetric | PointMetric | "steps"; kind: "steps" | "cumulative" | "point"; unit: string }> = {
  HKQuantityTypeIdentifierStepCount: { metric: "steps", kind: "steps", unit: "count" },
  HKQuantityTypeIdentifierDistanceWalkingRunning: { metric: "distance_m", kind: "cumulative", unit: "m" },
  HKQuantityTypeIdentifierActiveEnergyBurned: { metric: "active_energy_kcal", kind: "cumulative", unit: "kcal" },
  HKQuantityTypeIdentifierBasalEnergyBurned: { metric: "basal_energy_kcal", kind: "cumulative", unit: "kcal" },
  HKQuantityTypeIdentifierFlightsClimbed: { metric: "floors_climbed", kind: "cumulative", unit: "count" },
  HKQuantityTypeIdentifierAppleExerciseTime: { metric: "exercise_minutes", kind: "cumulative", unit: "min" },
  HKQuantityTypeIdentifierDietaryWater: { metric: "hydration_ml", kind: "cumulative", unit: "mL" },
  HKQuantityTypeIdentifierHeartRate: { metric: "heart_rate_bpm", kind: "point", unit: "count/min" },
  HKQuantityTypeIdentifierRestingHeartRate: { metric: "resting_heart_rate_bpm", kind: "point", unit: "count/min" },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: { metric: "hrv_sdnn_ms", kind: "point", unit: "ms" },
  HKQuantityTypeIdentifierOxygenSaturation: { metric: "blood_oxygen_pct", kind: "point", unit: "%" },
  HKQuantityTypeIdentifierRespiratoryRate: { metric: "respiratory_rate_bpm", kind: "point", unit: "count/min" },
  HKQuantityTypeIdentifierVO2Max: { metric: "vo2_max", kind: "point", unit: "mL/(kg*min)" },
  HKQuantityTypeIdentifierBodyMass: { metric: "weight_kg", kind: "point", unit: "kg" },
  HKQuantityTypeIdentifierBodyFatPercentage: { metric: "body_fat_pct", kind: "point", unit: "%" },
  HKQuantityTypeIdentifierBloodGlucose: { metric: "blood_glucose_mgdl", kind: "point", unit: "mg/dL" },
  HKQuantityTypeIdentifierDietaryCarbohydrates: { metric: "carbs_g", kind: "point", unit: "g" },
  // Insulin is special-cased below: one HK type holds both bolus (point) and
  // basal (cumulative), disambiguated by HKInsulinDeliveryReason metadata.
  HKQuantityTypeIdentifierInsulinDelivery: { metric: "insulin_bolus_units", kind: "point", unit: "IU" },
};

/** HKInsulinDeliveryReason metadata values. */
const INSULIN_REASON_BASAL = 1;
const INSULIN_REASON_BOLUS = 2;

export const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";
export const WORKOUT_TYPE = "HKWorkoutTypeIdentifier";

const metricToType = new Map(
  Object.entries(QUANTITY_TYPES).map(([type, info]) => [info.metric, { type, unit: info.unit }]),
);
metricToType.set("insulin_basal_units", {
  type: "HKQuantityTypeIdentifierInsulinDelivery",
  unit: "IU",
});

/** HKCategoryValueSleepAnalysis values. */
const HK_SLEEP_VALUES: Record<number, SleepStage> = {
  0: "in_bed",
  1: "asleep",
  2: "awake",
  3: "light", // asleepCore
  4: "deep", // asleepDeep
  5: "rem", // asleepREM
};
const SLEEP_STAGE_TO_HK: Record<SleepStage, number> = {
  in_bed: 0,
  asleep: 1,
  awake: 2,
  light: 3,
  deep: 4,
  rem: 5,
};

/** True when a human typed this sample in by hand (Health app manual entry). */
export function isUserEntered(dto: HKSampleDTO): boolean {
  const v = dto.metadata?.["HKWasUserEntered"];
  return v === 1 || v === true || v === "1";
}

/** Normalize a HealthKit source to a stable cross-platform device id. */
export function normalizeSource(dto: HKSampleDTO): SourceRef {
  // Manual entries outrank every device: the human knows their under-desk
  // treadmill walk better than a wrist that never moved. Give them a
  // dedicated source id so devicePriority can rank them first.
  if (isUserEntered(dto)) {
    return { id: "manual-entry", name: dto.sourceName ?? "Manual entry", platform: "apple" };
  }
  const product = dto.sourceProductType ?? "";
  const lowerName = (dto.sourceName ?? "").toLowerCase();
  const lowerBundle = (dto.sourceBundleId ?? "").toLowerCase();
  let id: string;
  if (lowerName.includes("garmin") || lowerBundle.includes("garmin")) id = "garmin";
  else if (product.startsWith("Watch")) id = "apple-watch";
  else if (product.startsWith("iPhone")) id = "iphone";
  else if (product.startsWith("iPad")) id = "ipad";
  else if (dto.sourceName) {
    id = dto.sourceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  } else {
    id = "apple-health";
  }
  return { id, name: dto.sourceName, platform: "apple" };
}

function externalIdOf(dto: HKSampleDTO): string | undefined {
  const v = dto.metadata?.[HK_EXTERNAL_ID_KEY];
  return typeof v === "string" ? v : undefined;
}

/** Convert quantity-sample DTOs to engine records. */
export function quantityToRecords(dtos: HKSampleDTO[]): HealthRecord[] {
  const out: HealthRecord[] = [];
  for (const dto of dtos) {
    const info = QUANTITY_TYPES[dto.typeIdentifier];
    if (!info) continue;
    const base = {
      nativeId: dto.uuid,
      start: dto.startMs,
      end: dto.endMs,
      source: normalizeSource(dto),
      externalId: externalIdOf(dto),
    };
    if (dto.typeIdentifier === "HKQuantityTypeIdentifierInsulinDelivery") {
      const reason = Number(dto.metadata?.["HKInsulinDeliveryReason"]);
      if (reason === INSULIN_REASON_BASAL) {
        out.push({ ...base, type: "cumulative", metric: "insulin_basal_units", value: dto.value });
      } else {
        out.push({ ...base, type: "point", metric: "insulin_bolus_units", value: dto.value, end: dto.startMs });
      }
      continue;
    }
    if (info.kind === "steps") {
      out.push({ ...base, type: "steps", steps: dto.value });
    } else if (info.kind === "cumulative") {
      out.push({ ...base, type: "cumulative", metric: info.metric, value: dto.value });
    } else {
      out.push({ ...base, type: "point", metric: info.metric as PointMetric, value: dto.value, end: dto.startMs });
    }
  }
  return out;
}

/**
 * HealthKit stores sleep as many per-stage category samples. Group contiguous
 * samples (gap < maxGapMs) from the same source into SleepSessions.
 */
export function categoryToSleepSessions(
  dtos: HKSampleDTO[],
  maxGapMs = 30 * 60_000,
): SleepSession[] {
  const bySource = new Map<string, { source: SourceRef; externalId?: string; stages: SleepStageInterval[] }[]>();
  const sorted = [...dtos]
    .filter((d) => d.typeIdentifier === SLEEP_TYPE)
    .sort((a, b) => a.startMs - b.startMs);

  for (const dto of sorted) {
    const stage = HK_SLEEP_VALUES[dto.value];
    if (!stage) continue;
    const source = normalizeSource(dto);
    const sessions = bySource.get(source.id) ?? [];
    const current = sessions[sessions.length - 1];
    const interval: SleepStageInterval = { stage, start: dto.startMs, end: dto.endMs };
    const externalId = externalIdOf(dto);
    const lastEnd = current?.stages[current.stages.length - 1]?.end ?? -Infinity;
    if (current && dto.startMs - lastEnd <= maxGapMs && externalId === current.externalId) {
      current.stages.push(interval);
    } else {
      sessions.push({ source, externalId, stages: [interval] });
    }
    bySource.set(source.id, sessions);
  }

  const out: SleepSession[] = [];
  for (const sessions of bySource.values()) {
    for (const s of sessions) {
      out.push({
        type: "sleep",
        source: s.source,
        externalId: s.externalId,
        start: s.stages[0]!.start,
        end: s.stages[s.stages.length - 1]!.end,
        stages: s.stages,
      });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Convert an engine record into the DTO(s) HealthKit should save. */
export function recordToDTOs(record: HealthRecord): HKSampleDTO[] {
  const metadata = record.externalId
    ? { [HK_EXTERNAL_ID_KEY]: record.externalId }
    : undefined;
  switch (record.type) {
    case "steps": {
      return [{
        typeIdentifier: "HKQuantityTypeIdentifierStepCount",
        unit: "count",
        value: record.steps,
        startMs: record.start,
        endMs: record.end,
        metadata,
      }];
    }
    case "cumulative":
    case "point": {
      const target = metricToType.get(record.metric);
      if (!target) return []; // metric with no HealthKit equivalent
      const insulinReason =
        record.metric === "insulin_basal_units"
          ? INSULIN_REASON_BASAL
          : record.metric === "insulin_bolus_units"
            ? INSULIN_REASON_BOLUS
            : undefined;
      return [{
        typeIdentifier: target.type,
        unit: target.unit,
        value: record.value,
        startMs: record.start,
        endMs: record.type === "point" ? record.start : record.end,
        metadata:
          insulinReason !== undefined
            ? { ...metadata, HKInsulinDeliveryReason: insulinReason }
            : metadata,
      }];
    }
    case "sleep": {
      const stages = record.stages.length
        ? record.stages
        : [{ stage: "asleep" as SleepStage, start: record.start, end: record.end }];
      return stages.map((st) => ({
        typeIdentifier: SLEEP_TYPE,
        value: SLEEP_STAGE_TO_HK[st.stage],
        startMs: st.start,
        endMs: st.end,
        metadata,
      }));
    }
    case "workout": {
      return [{
        typeIdentifier: WORKOUT_TYPE,
        value: 0,
        startMs: record.start,
        endMs: record.end,
        workoutActivityName: record.activity,
        totalEnergyKcal: record.activeEnergyKcal,
        totalDistanceM: record.distanceMeters,
        metadata,
      }];
    }
  }
}

/** Convert workout DTOs to engine records. */
export function workoutsToRecords(dtos: HKSampleDTO[]): HealthRecord[] {
  return dtos
    .filter((d) => d.typeIdentifier === WORKOUT_TYPE)
    .map((dto) => ({
      type: "workout" as const,
      nativeId: dto.uuid,
      start: dto.startMs,
      end: dto.endMs,
      source: normalizeSource(dto),
      externalId: externalIdOf(dto),
      activity: normalizeActivityName(dto.workoutActivityName ?? "other"),
      activeEnergyKcal: dto.totalEnergyKcal,
      distanceMeters: dto.totalDistanceM,
    }));
}

/** Normalize activity names so Apple and Fitbit agree ("Running" == "run"). */
export function normalizeActivityName(name: string): string {
  const n = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // split camelCase (HK enum names)
    .toLowerCase()
    .replace(/[^a-z]+/g, "_")
    .replace(/^_|_$/g, "");
  const aliases: Record<string, string> = {
    run: "running",
    running: "running",
    walk: "walking",
    walking: "walking",
    bike: "cycling",
    biking: "cycling",
    cycling: "cycling",
    outdoor_bike: "cycling",
    swim: "swimming",
    swimming: "swimming",
    strength_training: "strength_training",
    traditional_strength_training: "strength_training",
    weights: "strength_training",
    workout: "workout",
    hiking: "hiking",
    hike: "hiking",
    yoga: "yoga",
    elliptical: "elliptical",
    treadmill: "running",
    sport: "sport",
  };
  return aliases[n] ?? n;
}
