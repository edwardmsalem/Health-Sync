/**
 * Workout deduplication: two devices recording the same run produce two
 * workout records with heavily-overlapping intervals and the same (or
 * similar) activity type. Keep the higher-priority device's record.
 */

import type { WorkoutRecord } from "../types.js";
import { overlapMs, durationMs } from "../types.js";
import { DedupConfig, priorityRank } from "../config.js";

export function isDuplicateWorkout(
  a: WorkoutRecord,
  b: WorkoutRecord,
  threshold: number,
): boolean {
  if (a.activity !== b.activity) return false;
  const shorter = Math.min(durationMs(a), durationMs(b));
  if (shorter === 0) return false;
  return overlapMs(a, b) / shorter > threshold;
}

export interface DedupedWorkouts {
  workouts: WorkoutRecord[];
  dropped: WorkoutRecord[];
}

export function dedupeWorkouts(
  workouts: WorkoutRecord[],
  config: DedupConfig,
): DedupedWorkouts {
  // Best-first so a kept workout suppresses its lower-priority duplicates.
  const ordered = [...workouts].sort((a, b) => {
    const pr =
      priorityRank(config, a.source.id) - priorityRank(config, b.source.id);
    if (pr !== 0) return pr;
    return durationMs(b) - durationMs(a);
  });

  const kept: WorkoutRecord[] = [];
  const dropped: WorkoutRecord[] = [];
  for (const w of ordered) {
    if (
      kept.some((k) => isDuplicateWorkout(k, w, config.workoutOverlapThreshold))
    ) {
      dropped.push(w);
    } else {
      kept.push(w);
    }
  }
  kept.sort((a, b) => a.start - b.start);
  return { workouts: kept, dropped };
}
