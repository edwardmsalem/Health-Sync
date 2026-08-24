/**
 * Streaming parser for Apple Health's export.xml (Health app → profile
 * picture → "Export All Health Data" → export.zip → export.xml).
 *
 * Extracts only what Garmin can ingest: workouts and weight/body-fat.
 * Streaming (SAX) because real exports run to hundreds of MB.
 *
 * Handles both export formats: legacy attribute totals
 * (totalDistance/totalEnergyBurned on <Workout>) and the newer
 * <WorkoutStatistics> child elements (iOS 16+).
 */

import { createReadStream } from "node:fs";
import sax from "sax";
import type { PointSample, SourceRef, WorkoutRecord } from "health-sync";

/** Parse Apple's export timestamp "2026-07-17 07:00:00 -0400" to epoch ms. */
export function parseAppleDate(s: string): number {
  // -> "2026-07-17T07:00:00-04:00"
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!m) {
    const fallback = Date.parse(s);
    if (Number.isNaN(fallback)) throw new Error(`Unparseable date: ${s}`);
    return fallback;
  }
  return Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
}

function normalizeWorkoutType(hkType: string): string {
  // "HKWorkoutActivityTypeTraditionalStrengthTraining" -> "strength_training"-ish
  const raw = hkType.replace(/^HKWorkoutActivityType/, "");
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const aliases: Record<string, string> = {
    running: "running",
    walking: "walking",
    cycling: "cycling",
    swimming: "swimming",
    hiking: "hiking",
    yoga: "yoga",
    traditional_strength_training: "strength_training",
    functional_strength_training: "strength_training",
    high_intensity_interval_training: "hiit",
    elliptical: "elliptical",
    rowing: "rowing",
    stair_climbing: "stair_climbing",
  };
  return aliases[snake] ?? snake;
}

function sourceFor(sourceName: string | undefined): SourceRef {
  const name = sourceName ?? "Apple Health";
  const lower = name.toLowerCase();
  let id: string;
  if (lower.includes("watch")) id = "apple-watch";
  else if (lower.includes("iphone")) id = "iphone";
  else if (lower.includes("fitbit") || lower.includes("google")) id = "fitbit";
  else if (lower.includes("garmin") || lower.includes("connect")) id = "garmin";
  else if (lower.includes("health sync")) id = "health-sync";
  else id = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { id, name, platform: "apple" };
}

const LB_TO_KG = 0.45359237;

export interface ExportData {
  workouts: WorkoutRecord[];
  /** weight_kg and body_fat_pct point samples. */
  bodyMetrics: PointSample[];
}

export async function parseExportXml(path: string): Promise<ExportData> {
  const workouts: WorkoutRecord[] = [];
  const bodyMetrics: PointSample[] = [];

  // State for the <Workout> element currently open.
  let openWorkout: {
    attrs: Record<string, string>;
    statDistanceM?: number;
    statEnergyKcal?: number;
  } | null = null;

  const parser = sax.createStream(true, { trim: true });

  parser.on("opentag", (node: sax.Tag | sax.QualifiedTag) => {
    const attrs = node.attributes as Record<string, string>;
    if (node.name === "Workout") {
      openWorkout = { attrs };
    } else if (node.name === "WorkoutStatistics" && openWorkout) {
      const sum = Number(attrs.sum);
      if (Number.isNaN(sum)) return;
      if (attrs.type?.startsWith("HKQuantityTypeIdentifierDistance")) {
        const unit = attrs.unit ?? "km";
        openWorkout.statDistanceM =
          unit === "km" ? sum * 1000 : unit === "mi" ? sum * 1609.344 : sum;
      } else if (attrs.type === "HKQuantityTypeIdentifierActiveEnergyBurned") {
        openWorkout.statEnergyKcal = sum;
      }
    } else if (node.name === "Record") {
      const type = attrs.type;
      if (
        type !== "HKQuantityTypeIdentifierBodyMass" &&
        type !== "HKQuantityTypeIdentifierBodyFatPercentage"
      ) {
        return;
      }
      const value = Number(attrs.value);
      if (Number.isNaN(value) || !attrs.startDate) return;
      const at = parseAppleDate(attrs.startDate);
      if (type === "HKQuantityTypeIdentifierBodyMass") {
        const unit = attrs.unit ?? "kg";
        const kg = unit === "lb" ? value * LB_TO_KG : value;
        bodyMetrics.push({
          type: "point",
          metric: "weight_kg",
          value: Math.round(kg * 100) / 100,
          start: at,
          end: at,
          source: sourceFor(attrs.sourceName),
        });
      } else {
        // HealthKit stores body fat as a 0-1 fraction.
        const pct = value <= 1 ? value * 100 : value;
        bodyMetrics.push({
          type: "point",
          metric: "body_fat_pct",
          value: Math.round(pct * 10) / 10,
          start: at,
          end: at,
          source: sourceFor(attrs.sourceName),
        });
      }
    }
  });

  parser.on("closetag", (name: string) => {
    if (name !== "Workout" || !openWorkout) return;
    const a = openWorkout.attrs;
    try {
      const start = parseAppleDate(a.startDate!);
      const end = parseAppleDate(a.endDate!);
      const legacyDistance = a.totalDistance ? Number(a.totalDistance) : undefined;
      const legacyDistanceM =
        legacyDistance !== undefined && !Number.isNaN(legacyDistance)
          ? (a.totalDistanceUnit ?? "km") === "mi"
            ? legacyDistance * 1609.344
            : legacyDistance * 1000
          : undefined;
      const legacyEnergy = a.totalEnergyBurned ? Number(a.totalEnergyBurned) : undefined;
      const distanceMeters = openWorkout.statDistanceM ?? legacyDistanceM;
      const activeEnergyKcal = openWorkout.statEnergyKcal ?? legacyEnergy;
      workouts.push({
        type: "workout",
        activity: normalizeWorkoutType(a.workoutActivityType ?? "Other"),
        start,
        end,
        source: sourceFor(a.sourceName),
        distanceMeters:
          distanceMeters !== undefined ? Math.round(distanceMeters) : undefined,
        activeEnergyKcal:
          activeEnergyKcal !== undefined && !Number.isNaN(activeEnergyKcal)
            ? Math.round(activeEnergyKcal)
            : undefined,
      });
    } catch {
      // Skip malformed workout entries rather than aborting a 500MB parse.
    }
    openWorkout = null;
  });

  await new Promise<void>((resolve, reject) => {
    parser.on("end", resolve);
    parser.on("error", reject);
    createReadStream(path).pipe(parser);
  });

  workouts.sort((a, b) => a.start - b.start);
  bodyMetrics.sort((a, b) => a.start - b.start);
  return { workouts, bodyMetrics };
}
