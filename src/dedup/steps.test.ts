import { describe, it, expect } from "vitest";
import { dedupeSteps } from "./steps.js";
import { DEFAULT_DEDUP_CONFIG, DedupConfig } from "../config.js";
import type { SourceRef, StepsSample } from "../types.js";

const H = 3_600_000;
const M = 60_000;
const T0 = Date.UTC(2026, 6, 17, 8, 0, 0); // aligned to a minute boundary

const watch: SourceRef = { id: "apple-watch", platform: "apple" };
const fitbit: SourceRef = { id: "fitbit-air", platform: "google" };
const iphone: SourceRef = { id: "iphone", platform: "apple" };

const sample = (
  source: SourceRef,
  start: number,
  end: number,
  steps: number,
): StepsSample => ({ type: "steps", source, start, end, steps });

const cfg = (over: Partial<DedupConfig> = {}): DedupConfig => ({
  ...DEFAULT_DEDUP_CONFIG,
  devicePriority: ["apple-watch", "fitbit-air", "iphone"],
  ...over,
});

describe("dedupeSteps", () => {
  it("does not sum two devices covering the same interval", () => {
    const result = dedupeSteps(
      [
        sample(watch, T0, T0 + H, 4200),
        sample(fitbit, T0, T0 + H, 4350),
      ],
      cfg({ stepsStrategy: "max" }),
    );
    // Naive sum would be 8550; the winner per minute is fitbit (more steps).
    expect(result.rawTotal).toBe(8550);
    expect(result.total).toBe(4350);
  });

  it("priority strategy lets the trusted device win contested minutes", () => {
    const result = dedupeSteps(
      [
        sample(watch, T0, T0 + H, 4200),
        sample(fitbit, T0, T0 + H, 4350),
      ],
      cfg({ stepsStrategy: "priority" }),
    );
    expect(result.total).toBe(4200);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]!.source.id).toBe("apple-watch");
  });

  it("keeps non-overlapping portions from both devices", () => {
    // Fitbit worn 08:00-09:00, Watch worn 08:30-09:30.
    const result = dedupeSteps(
      [
        sample(fitbit, T0, T0 + H, 3000),
        sample(watch, T0 + 30 * M, T0 + 90 * M, 3600),
      ],
      cfg({ stepsStrategy: "priority" }),
    );
    // 08:00-08:30 fitbit only: 1500. 08:30-09:00 contested -> watch: 1800.
    // 09:00-09:30 watch only: 1800. Total 5100, not 6600.
    expect(result.total).toBe(5100);
    const bySource = Object.fromEntries(
      result.samples.map((s) => [s.source.id, (result.samples.filter(x => x.source.id === s.source.id)).reduce((sum, x) => sum + x.steps, 0)]),
    );
    expect(bySource["fitbit-air"]).toBe(1500);
    expect(bySource["apple-watch"]).toBe(3600);
  });

  it("handles three overlapping sources (watch + fitbit + phone)", () => {
    const result = dedupeSteps(
      [
        sample(watch, T0, T0 + H, 4200),
        sample(fitbit, T0, T0 + H, 4350),
        sample(iphone, T0, T0 + H, 3900),
      ],
      cfg({ stepsStrategy: "priority" }),
    );
    expect(result.total).toBe(4200); // watch wins everything
    expect(result.rawTotal).toBe(12450);
  });

  it("sums multiple samples from the SAME source (bucketing, not dedup)", () => {
    const result = dedupeSteps(
      [
        sample(watch, T0, T0 + 15 * M, 500),
        sample(watch, T0 + 15 * M, T0 + 30 * M, 700),
      ],
      cfg(),
    );
    expect(result.total).toBe(1200);
  });

  it("leaves single-source data untouched in total", () => {
    const result = dedupeSteps([sample(fitbit, T0, T0 + H, 3100)], cfg());
    expect(result.total).toBe(3100);
    expect(result.samples[0]!.start).toBe(T0);
    expect(result.samples[0]!.end).toBe(T0 + H);
  });

  it("unlisted devices fall back to max under priority strategy", () => {
    const unknownA: SourceRef = { id: "mystery-band", platform: "google" };
    const unknownB: SourceRef = { id: "other-band", platform: "apple" };
    const result = dedupeSteps(
      [
        sample(unknownA, T0, T0 + H, 2000),
        sample(unknownB, T0, T0 + H, 2500),
      ],
      cfg({ stepsStrategy: "priority" }),
    );
    expect(result.total).toBe(2500);
  });

  it("ignores empty and zero-step samples", () => {
    const result = dedupeSteps(
      [
        sample(watch, T0, T0, 100), // zero-length
        sample(watch, T0, T0 + M, 0), // zero steps
      ],
      cfg(),
    );
    expect(result.total).toBe(0);
    expect(result.samples).toHaveLength(0);
  });

  it("proportionally allocates samples not aligned to minute boundaries", () => {
    // 90 steps over 08:00:30-08:02:00 (1.5 min): 30s->30 steps, 60s->60 steps.
    const result = dedupeSteps(
      [sample(watch, T0 + 30_000, T0 + 2 * M, 90)],
      cfg(),
    );
    expect(result.total).toBe(90);
  });
});
