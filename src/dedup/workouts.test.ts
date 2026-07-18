import { describe, it, expect } from "vitest";
import { dedupeWorkouts } from "./workouts.js";
import { DEFAULT_DEDUP_CONFIG, DedupConfig } from "../config.js";
import type { SourceRef, WorkoutRecord } from "../types.js";

const M = 60_000;
const T0 = Date.UTC(2026, 6, 17, 7, 0, 0);

const watch: SourceRef = { id: "apple-watch", platform: "apple" };
const fitbit: SourceRef = { id: "fitbit-air", platform: "google" };

const workout = (
  source: SourceRef,
  start: number,
  end: number,
  activity = "running",
): WorkoutRecord => ({ type: "workout", source, start, end, activity });

const cfg: DedupConfig = {
  ...DEFAULT_DEDUP_CONFIG,
  devicePriority: ["apple-watch", "fitbit-air"],
};

describe("dedupeWorkouts", () => {
  it("drops the lower-priority copy of the same run", () => {
    const result = dedupeWorkouts(
      [
        workout(fitbit, T0 + 1 * M, T0 + 31 * M),
        workout(watch, T0, T0 + 30 * M),
      ],
      cfg,
    );
    expect(result.workouts).toHaveLength(1);
    expect(result.workouts[0]!.source.id).toBe("apple-watch");
    expect(result.dropped).toHaveLength(1);
  });

  it("keeps different activities even when overlapping", () => {
    const result = dedupeWorkouts(
      [
        workout(watch, T0, T0 + 30 * M, "running"),
        workout(fitbit, T0, T0 + 30 * M, "cycling"),
      ],
      cfg,
    );
    expect(result.workouts).toHaveLength(2);
  });

  it("keeps back-to-back workouts with minor overlap", () => {
    const result = dedupeWorkouts(
      [
        workout(watch, T0, T0 + 30 * M),
        workout(watch, T0 + 28 * M, T0 + 60 * M),
      ],
      cfg,
    );
    expect(result.workouts).toHaveLength(2);
  });
});
