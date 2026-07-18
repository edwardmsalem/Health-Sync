/**
 * Pure serializers: engine records -> Fitbit Web API write requests.
 *
 * The Fitbit API cannot ingest everything (no endpoint accepts raw step or
 * heart-rate samples), so serialization is partial by design: `null` means
 * "this record has no Fitbit write path" and the bridge reports it as
 * skipped rather than failing the sync.
 */

import type { HealthRecord } from "health-sync";

export interface FitbitWrite {
  kind: "sleep" | "activity" | "weight";
  path: string;
  /** application/x-www-form-urlencoded body. */
  params: Record<string, string>;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format epoch ms as Fitbit local date/time strings for the given offset. */
export function toLocalParts(
  epochMs: number,
  utcOffsetMs: number,
): { date: string; time: string } {
  const d = new Date(epochMs + utcOffsetMs);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/** Fitbit activity type id for "generic workout" when no better match. */
const ACTIVITY_IDS: Record<string, number> = {
  running: 90009,
  walking: 90013,
  cycling: 90001,
  swimming: 90024,
  hiking: 90012,
  yoga: 52000,
  strength_training: 2050,
};

export function serializeRecord(
  record: HealthRecord,
  utcOffsetMs: number,
): FitbitWrite | null {
  switch (record.type) {
    case "sleep": {
      const { date, time } = toLocalParts(record.start, utcOffsetMs);
      return {
        kind: "sleep",
        path: "/1.2/user/-/sleep.json",
        params: {
          date,
          startTime: time,
          duration: String(record.end - record.start),
        },
      };
    }
    case "workout": {
      const { date, time } = toLocalParts(record.start, utcOffsetMs);
      const params: Record<string, string> = {
        date,
        startTime: time,
        durationMillis: String(record.end - record.start),
        manualCalories: String(Math.round(record.activeEnergyKcal ?? 0)),
      };
      const id = ACTIVITY_IDS[record.activity];
      if (id) params.activityId = String(id);
      else params.activityName = record.activity;
      if (record.distanceMeters !== undefined) {
        params.distance = String(record.distanceMeters / 1000);
        params.distanceUnit = "Kilometer";
      }
      return { kind: "activity", path: "/1/user/-/activities.json", params };
    }
    case "point": {
      if (record.metric === "weight_kg") {
        const { date, time } = toLocalParts(record.start, utcOffsetMs);
        return {
          kind: "weight",
          path: "/1/user/-/body/log/weight.json",
          params: { weight: String(record.value), date, time: `${time}:00` },
        };
      }
      if (record.metric === "body_fat_pct") {
        const { date, time } = toLocalParts(record.start, utcOffsetMs);
        return {
          kind: "weight",
          path: "/1/user/-/body/log/fat.json",
          params: { fat: String(record.value), date, time: `${time}:00` },
        };
      }
      return null; // heart rate, SpO2, ... have no Fitbit write endpoint
    }
    case "steps":
    case "cumulative":
      return null; // Fitbit has no API for raw step/distance/energy samples
  }
}

export function deletePathFor(kind: FitbitWrite["kind"], logId: string): string {
  switch (kind) {
    case "sleep":
      return `/1.2/user/-/sleep/${logId}.json`;
    case "activity":
      return `/1/user/-/activities/${logId}.json`;
    case "weight":
      return `/1/user/-/body/log/weight/${logId}.json`;
  }
}
