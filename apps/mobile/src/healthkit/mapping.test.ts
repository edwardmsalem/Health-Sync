import { describe, it, expect } from "vitest";
import {
  HK_EXTERNAL_ID_KEY,
  categoryToSleepSessions,
  normalizeActivityName,
  normalizeSource,
  quantityToRecords,
  recordToDTOs,
  type HKSampleDTO,
} from "./mapping.ts";

const T0 = Date.UTC(2026, 6, 17, 8, 0, 0);
const M = 60_000;
const H = 3_600_000;

const dto = (over: Partial<HKSampleDTO>): HKSampleDTO => ({
  typeIdentifier: "HKQuantityTypeIdentifierStepCount",
  value: 100,
  startMs: T0,
  endMs: T0 + 15 * M,
  sourceProductType: "Watch7,2",
  sourceName: "Edward's Apple Watch",
  ...over,
});

describe("normalizeSource", () => {
  it("maps Watch/iPhone product types to stable ids", () => {
    expect(normalizeSource(dto({})).id).toBe("apple-watch");
    expect(normalizeSource(dto({ sourceProductType: "iPhone17,1" })).id).toBe("iphone");
  });

  it("slugs third-party app names", () => {
    expect(
      normalizeSource(dto({ sourceProductType: undefined, sourceName: "Fitbit" })).id,
    ).toBe("fitbit");
  });
});

describe("quantityToRecords", () => {
  it("converts steps and preserves the sync tag", () => {
    const records = quantityToRecords([
      dto({ metadata: { [HK_EXTERNAL_ID_KEY]: "health-sync:abc" } }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "steps",
      steps: 100,
      externalId: "health-sync:abc",
    });
  });

  it("maps heart rate to an instantaneous point sample", () => {
    const records = quantityToRecords([
      dto({ typeIdentifier: "HKQuantityTypeIdentifierHeartRate", value: 72, endMs: T0 + M }),
    ]);
    expect(records[0]).toMatchObject({
      type: "point",
      metric: "heart_rate_bpm",
      value: 72,
      start: T0,
      end: T0,
    });
  });

  it("ignores unknown type identifiers", () => {
    expect(quantityToRecords([dto({ typeIdentifier: "HKQuantityTypeIdentifierNikeFuel" })])).toHaveLength(0);
  });
});

describe("categoryToSleepSessions", () => {
  const sleepDto = (start: number, end: number, value: number): HKSampleDTO =>
    dto({
      typeIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
      value,
      startMs: start,
      endMs: end,
    });

  it("groups contiguous stage samples into one session", () => {
    const night = Date.UTC(2026, 6, 16, 23, 0, 0);
    const sessions = categoryToSleepSessions([
      sleepDto(night, night + 2 * H, 3), // core -> light
      sleepDto(night + 2 * H, night + 3 * H, 4), // deep
      sleepDto(night + 3 * H, night + 4 * H, 5), // rem
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.start).toBe(night);
    expect(sessions[0]!.end).toBe(night + 4 * H);
    expect(sessions[0]!.stages.map((s) => s.stage)).toEqual(["light", "deep", "rem"]);
  });

  it("splits sessions separated by more than the gap threshold", () => {
    const night = Date.UTC(2026, 6, 16, 23, 0, 0);
    const sessions = categoryToSleepSessions([
      sleepDto(night, night + 7 * H, 1),
      sleepDto(night + 15 * H, night + 16 * H, 1), // afternoon nap
    ]);
    expect(sessions).toHaveLength(2);
  });
});

describe("recordToDTOs", () => {
  it("expands a staged sleep session into per-stage category samples", () => {
    const night = Date.UTC(2026, 6, 16, 23, 0, 0);
    const dtos = recordToDTOs({
      type: "sleep",
      source: { id: "fitbit", platform: "google" },
      externalId: "health-sync:xyz",
      start: night,
      end: night + 2 * H,
      stages: [
        { stage: "light", start: night, end: night + H },
        { stage: "deep", start: night + H, end: night + 2 * H },
      ],
    });
    expect(dtos).toHaveLength(2);
    expect(dtos[0]).toMatchObject({ value: 3, metadata: { [HK_EXTERNAL_ID_KEY]: "health-sync:xyz" } });
    expect(dtos[1]).toMatchObject({ value: 4 });
  });

  it("round-trips a cumulative metric", () => {
    const dtos = recordToDTOs({
      type: "cumulative",
      metric: "distance_m",
      value: 3200,
      start: T0,
      end: T0 + H,
      source: { id: "fitbit", platform: "google" },
    });
    expect(dtos[0]).toMatchObject({
      typeIdentifier: "HKQuantityTypeIdentifierDistanceWalkingRunning",
      unit: "m",
      value: 3200,
    });
  });

  it("returns nothing for metrics HealthKit cannot store", () => {
    expect(
      recordToDTOs({
        type: "point",
        metric: "some_vendor_metric",
        value: 1,
        start: T0,
        end: T0,
        source: { id: "fitbit", platform: "google" },
      }),
    ).toHaveLength(0);
  });
});

describe("normalizeActivityName", () => {
  it("aligns Apple and Fitbit naming", () => {
    expect(normalizeActivityName("Running")).toBe("running");
    expect(normalizeActivityName("Run")).toBe("running");
    expect(normalizeActivityName("Outdoor Bike")).toBe("cycling");
    expect(normalizeActivityName("TraditionalStrengthTraining")).toBe("strength_training");
  });
});

describe("manual entries and Garmin sources", () => {
  it("user-entered samples map to the manual-entry source", () => {
    const records = quantityToRecords([
      dto({
        sourceProductType: "iPhone17,1",
        sourceName: "Health",
        metadata: { HKWasUserEntered: 1 },
      }),
    ]);
    expect(records[0]!.source.id).toBe("manual-entry");
  });

  it("Garmin Connect samples map to the garmin source", () => {
    const records = quantityToRecords([
      dto({
        sourceProductType: undefined,
        sourceName: "Connect",
        sourceBundleId: "com.garmin.connect.mobile",
      }),
    ]);
    expect(records[0]!.source.id).toBe("garmin");
  });
});

describe("diabetes metrics", () => {
  it("splits insulin delivery into bolus (point) and basal (cumulative) by reason", () => {
    const records = quantityToRecords([
      dto({
        typeIdentifier: "HKQuantityTypeIdentifierInsulinDelivery",
        value: 4.5,
        metadata: { HKInsulinDeliveryReason: 2 },
      }),
      dto({
        typeIdentifier: "HKQuantityTypeIdentifierInsulinDelivery",
        value: 0.6,
        startMs: T0,
        endMs: T0 + 30 * M,
        metadata: { HKInsulinDeliveryReason: 1 },
      }),
    ]);
    expect(records[0]).toMatchObject({ type: "point", metric: "insulin_bolus_units", value: 4.5 });
    expect(records[1]).toMatchObject({
      type: "cumulative",
      metric: "insulin_basal_units",
      value: 0.6,
      end: T0 + 30 * M,
    });
  });

  it("writes insulin back with the reason metadata and the sync tag", () => {
    const dtos = recordToDTOs({
      type: "cumulative",
      metric: "insulin_basal_units",
      value: 0.6,
      start: T0,
      end: T0 + 30 * M,
      source: { id: "aaps", platform: "nightscout" },
      externalId: "health-sync:abc",
    });
    expect(dtos[0]).toMatchObject({
      typeIdentifier: "HKQuantityTypeIdentifierInsulinDelivery",
      unit: "IU",
      metadata: { HKInsulinDeliveryReason: 1, [HK_EXTERNAL_ID_KEY]: "health-sync:abc" },
    });
    const glucose = recordToDTOs({
      type: "point",
      metric: "blood_glucose_mgdl",
      value: 115,
      start: T0,
      end: T0,
      source: { id: "aaps", platform: "nightscout" },
    });
    expect(glucose[0]!.typeIdentifier).toBe("HKQuantityTypeIdentifierBloodGlucose");
  });
});

describe("HealthKit-derived (read-only) quantity types", () => {
  it("still reads exercise time", () => {
    const records = quantityToRecords([
      dto({ typeIdentifier: "HKQuantityTypeIdentifierAppleExerciseTime", value: 22 }),
    ]);
    expect(records[0]).toMatchObject({
      type: "cumulative",
      metric: "exercise_minutes",
      value: 22,
    });
  });

  it("never produces a write for one", () => {
    // HealthKit computes exercise time itself; saving it is rejected.
    expect(
      recordToDTOs({
        type: "cumulative",
        metric: "exercise_minutes",
        value: 22,
        start: T0,
        end: T0 + 22 * M,
        source: { id: "fitbit", platform: "google" },
      }),
    ).toHaveLength(0);
  });

  it("writeable metrics are unaffected", () => {
    expect(
      recordToDTOs({
        type: "cumulative",
        metric: "distance_m",
        value: 3200,
        start: T0,
        end: T0 + M,
        source: { id: "fitbit", platform: "google" },
      }),
    ).toHaveLength(1);
  });
});
