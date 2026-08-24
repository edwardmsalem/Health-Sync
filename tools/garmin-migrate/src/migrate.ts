/**
 * Orchestration: parse sources -> dedupe with the engine -> emit
 * Garmin-ready artifacts (one TCX per workout + weight.csv + summary).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_DEDUP_CONFIG,
  dedupePoints,
  dedupeWorkouts,
  type DedupConfig,
  type PointSample,
  type WorkoutRecord,
} from "health-sync";
import { tcxFilename, workoutToTcx } from "./tcx.ts";

export interface MigrateInput {
  workouts: WorkoutRecord[];
  bodyMetrics: PointSample[];
  outDir: string;
  /** Only include records starting on/after this epoch ms. */
  sinceMs?: number;
}

export interface MigrateResult {
  tcxFiles: string[];
  weightRows: number;
  duplicateWorkoutsDropped: number;
  duplicateBodyMetricsDropped: number;
}

const MIGRATE_DEDUP: DedupConfig = {
  ...DEFAULT_DEDUP_CONFIG,
  // Same physical truth recorded by several sources: trust Apple's (watch)
  // record of a workout over Fitbit's copy, wearables over the phone.
  devicePriority: ["apple-watch", "garmin", "fitbit", "iphone", "health-sync"],
  // Two records of the same session from different trackers rarely align
  // exactly; anything sharing most of its time span is one workout.
  workoutOverlapThreshold: 0.4,
  // Weigh-ins logged to two apps within an hour are the same weigh-in.
  pointToleranceMs: 60 * 60 * 1000,
};

export function buildWeightCsv(points: PointSample[]): string {
  const byTime = new Map<number, { weightKg?: number; bodyFatPct?: number }>();
  for (const p of points) {
    const entry = byTime.get(p.start) ?? {};
    if (p.metric === "weight_kg") entry.weightKg = p.value;
    if (p.metric === "body_fat_pct") entry.bodyFatPct = p.value;
    byTime.set(p.start, entry);
  }
  const lines = ["timestamp_iso,weight_kg,body_fat_pct"];
  for (const [at, entry] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
    if (entry.weightKg === undefined && entry.bodyFatPct === undefined) continue;
    lines.push(
      `${new Date(at).toISOString()},${entry.weightKg ?? ""},${entry.bodyFatPct ?? ""}`,
    );
  }
  return lines.join("\n") + "\n";
}

export async function migrate(input: MigrateInput): Promise<MigrateResult> {
  const since = input.sinceMs ?? 0;
  const workoutsInRange = input.workouts.filter(
    // Skip records this sync engine authored — they're copies of another
    // platform's data that is already present natively in one of the inputs.
    (w) => w.start >= since && w.source.id !== "health-sync",
  );
  const bodyInRange = input.bodyMetrics.filter(
    (p) => p.start >= since && p.source.id !== "health-sync",
  );

  const { workouts, dropped } = dedupeWorkouts(workoutsInRange, MIGRATE_DEDUP);
  const { points, dropped: droppedPoints } = dedupePoints(bodyInRange, MIGRATE_DEDUP);

  const tcxDir = join(input.outDir, "tcx");
  await mkdir(tcxDir, { recursive: true });

  const tcxFiles: string[] = [];
  const seenNames = new Set<string>();
  for (const w of workouts) {
    let name = tcxFilename(w);
    while (seenNames.has(name)) name = name.replace(/\.tcx$/, "_b.tcx");
    seenNames.add(name);
    await writeFile(join(tcxDir, name), workoutToTcx(w), "utf8");
    tcxFiles.push(name);
  }

  const weightCsv = buildWeightCsv(points);
  const weightRows = weightCsv.trim().split("\n").length - 1;
  await writeFile(join(input.outDir, "weight.csv"), weightCsv, "utf8");

  await writeFile(
    join(input.outDir, "summary.json"),
    JSON.stringify(
      {
        workouts: workouts.length,
        duplicateWorkoutsDropped: dropped.length,
        weightAndBodyFatEntries: weightRows,
        duplicateBodyMetricsDropped: droppedPoints.length,
        firstWorkout: workouts[0] ? new Date(workouts[0].start).toISOString() : null,
        lastWorkout: workouts.at(-1)
          ? new Date(workouts.at(-1)!.start).toISOString()
          : null,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    tcxFiles,
    weightRows,
    duplicateWorkoutsDropped: dropped.length,
    duplicateBodyMetricsDropped: droppedPoints.length,
  };
}
