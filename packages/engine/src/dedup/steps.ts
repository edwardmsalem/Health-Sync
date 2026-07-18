/**
 * Overlap-aware step deduplication.
 *
 * Problem: when you wear an Apple Watch and a Fitbit at the same time, both
 * record steps for the same walk. Naively merging both platforms' data sums
 * them and doubles your step count.
 *
 * Approach (similar to Apple Health's own source arbitration):
 *   1. Slice every sample onto a minute-resolution timeline, allocating a
 *      sample's steps proportionally across the minutes it spans.
 *   2. For each minute, group contributions by source. Multiple samples from
 *      the SAME source in one minute are summed (that's just bucketing);
 *      contributions from DIFFERENT sources are competing measurements of the
 *      same real-world minute, so exactly one source wins the minute:
 *        - "priority": the highest-priority device present wins;
 *        - "max":      the device that saw the most steps wins.
 *   3. Re-aggregate consecutive winning minutes from the same source back
 *      into contiguous samples.
 *
 * The result is a single canonical step timeline with no double counting,
 * which also gracefully handles partial overlap (watch worn 9:00-10:00,
 * Fitbit worn 8:30-9:30 → Fitbit covers 8:30-9:00, winner covers 9:00-9:30,
 * watch covers 9:30-10:00).
 *
 * The minute-arbitration core lives in series.ts and is shared with every
 * other cumulative metric (distance, calories, floors, ...).
 */

import type { StepsSample, EpochMs } from "../types.js";
import { DedupConfig } from "../config.js";
import { dedupeSeries, MINUTE_MS } from "./series.js";

export interface DedupedSteps {
  /** Canonical, non-overlapping step samples (minute-aligned). */
  samples: StepsSample[];
  /** Total steps after dedup. */
  total: number;
  /** Sum of raw input steps, for reporting how much double counting was removed. */
  rawTotal: number;
}

/**
 * Merge step samples from any number of sources/platforms into one canonical
 * timeline with no double counting.
 */
export function dedupeSteps(
  samples: StepsSample[],
  config: DedupConfig,
): DedupedSteps {
  const result = dedupeSeries(
    samples.map((s) => ({
      start: s.start,
      end: s.end,
      value: s.steps,
      source: s.source,
    })),
    config,
  );
  const out: StepsSample[] = result.samples.map((s) => ({
    type: "steps",
    start: s.start,
    end: s.end,
    steps: Math.round(s.value),
    source: s.source,
  }));
  return {
    samples: out,
    total: out.reduce((sum, s) => sum + s.steps, 0),
    rawTotal: Math.round(result.rawTotal),
  };
}

export { MINUTE_MS };
export type { EpochMs };
