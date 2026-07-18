import { describe, it, expect } from "vitest";
import { dedupePoints } from "./points.js";
import { dedupeCumulative } from "./cumulative.js";
import { DEFAULT_DEDUP_CONFIG, DedupConfig } from "../config.js";
import type { CumulativeSample, PointSample, SourceRef } from "../types.js";

const H = 3_600_000;
const M = 60_000;
const T0 = Date.UTC(2026, 6, 17, 8, 0, 0);

const watch: SourceRef = { id: "apple-watch", platform: "apple" };
const fitbit: SourceRef = { id: "fitbit-air", platform: "google" };
const scale: SourceRef = { id: "withings-scale", platform: "google" };

const point = (
  source: SourceRef,
  at: number,
  metric: PointSample["metric"],
  value: number,
): PointSample => ({ type: "point", source, start: at, end: at, metric, value });

const cfg = (over: Partial<DedupConfig> = {}): DedupConfig => ({
  ...DEFAULT_DEDUP_CONFIG,
  devicePriority: ["apple-watch", "fitbit-air"],
  ...over,
});

describe("dedupePoints", () => {
  it("drops the lower-priority device's near-simultaneous heart rate", () => {
    const result = dedupePoints(
      [
        point(watch, T0, "heart_rate_bpm", 72),
        point(fitbit, T0 + 2 * M, "heart_rate_bpm", 75),
      ],
      cfg(),
    );
    expect(result.points).toHaveLength(1);
    expect(result.points[0]!.source.id).toBe("apple-watch");
    expect(result.dropped).toHaveLength(1);
  });

  it("keeps readings far enough apart, from either device", () => {
    const result = dedupePoints(
      [
        point(watch, T0, "heart_rate_bpm", 72),
        point(fitbit, T0 + 20 * M, "heart_rate_bpm", 80),
      ],
      cfg(),
    );
    expect(result.points).toHaveLength(2);
  });

  it("never dedupes a device against its own series", () => {
    const result = dedupePoints(
      [
        point(watch, T0, "heart_rate_bpm", 72),
        point(watch, T0 + 1 * M, "heart_rate_bpm", 74),
        point(watch, T0 + 2 * M, "heart_rate_bpm", 76),
      ],
      cfg(),
    );
    expect(result.points).toHaveLength(3);
  });

  it("treats different metrics independently", () => {
    const result = dedupePoints(
      [
        point(watch, T0, "heart_rate_bpm", 72),
        point(fitbit, T0, "blood_oxygen_pct", 97),
        point(scale, T0, "weight_kg", 82.4),
      ],
      cfg(),
    );
    expect(result.points).toHaveLength(3);
  });

  it("interleaved all-day series: better device wins contested moments only", () => {
    // Watch samples every 10 min for the first half hour; Fitbit every 5 min
    // across the full hour. Fitbit keeps only moments the watch didn't cover.
    const samples: PointSample[] = [];
    for (let t = 0; t <= 30 * M; t += 10 * M)
      samples.push(point(watch, T0 + t, "heart_rate_bpm", 70));
    for (let t = 0; t <= 60 * M; t += 5 * M)
      samples.push(point(fitbit, T0 + t, "heart_rate_bpm", 71));
    const result = dedupePoints(samples, cfg());
    const fitbitKept = result.points.filter((p) => p.source.id === "fitbit-air");
    // Fitbit's 35..60 min samples (6 readings) are outside watch coverage
    // (last watch reading at +30, tolerance 5 min → +35 is contested).
    expect(result.points.filter((p) => p.source.id === "apple-watch")).toHaveLength(4);
    for (const p of fitbitKept) {
      expect(p.start).toBeGreaterThan(T0 + 35 * M);
    }
  });
});

describe("dedupeCumulative", () => {
  const sample = (
    source: SourceRef,
    start: number,
    end: number,
    metric: CumulativeSample["metric"],
    value: number,
  ): CumulativeSample => ({ type: "cumulative", source, start, end, metric, value });

  it("does not sum two devices' distance for the same walk", () => {
    const result = dedupeCumulative(
      [
        sample(watch, T0, T0 + H, "distance_m", 3200),
        sample(fitbit, T0, T0 + H, "distance_m", 3350),
      ],
      cfg({ stepsStrategy: "priority" }),
    );
    expect(result.totals["distance_m"]!.rawTotal).toBe(6550);
    expect(result.totals["distance_m"]!.total).toBe(3200);
  });

  it("arbitrates each metric independently", () => {
    const result = dedupeCumulative(
      [
        sample(watch, T0, T0 + H, "distance_m", 3200),
        sample(fitbit, T0, T0 + H, "active_energy_kcal", 210),
      ],
      cfg(),
    );
    expect(result.samples).toHaveLength(2);
    expect(result.totals["distance_m"]!.total).toBe(3200);
    expect(result.totals["active_energy_kcal"]!.total).toBe(210);
  });

  it("preserves fractional values (kcal, liters) without integer rounding", () => {
    const result = dedupeCumulative(
      [sample(watch, T0, T0 + 30 * M, "active_energy_kcal", 123.45)],
      cfg(),
    );
    expect(result.totals["active_energy_kcal"]!.total).toBeCloseTo(123.45, 2);
  });
});
