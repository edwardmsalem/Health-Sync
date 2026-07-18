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
 */

import type { StepsSample, SourceRef, EpochMs } from "../types.js";
import { DedupConfig, priorityRank } from "../config.js";

const MINUTE_MS = 60_000;

interface MinuteContribution {
  source: SourceRef;
  steps: number;
}

/** Per-minute step contributions, keyed by minute index (epochMs / 60000). */
type MinuteMap = Map<number, Map<string, MinuteContribution>>;

function sliceIntoMinutes(samples: StepsSample[]): MinuteMap {
  const minutes: MinuteMap = new Map();
  for (const sample of samples) {
    const span = sample.end - sample.start;
    if (span <= 0 || sample.steps <= 0) continue;
    const firstMinute = Math.floor(sample.start / MINUTE_MS);
    const lastMinute = Math.floor((sample.end - 1) / MINUTE_MS);
    for (let m = firstMinute; m <= lastMinute; m++) {
      const minuteStart = m * MINUTE_MS;
      const minuteEnd = minuteStart + MINUTE_MS;
      const overlap =
        Math.min(sample.end, minuteEnd) - Math.max(sample.start, minuteStart);
      const share = (sample.steps * overlap) / span;
      if (share <= 0) continue;
      let bySource = minutes.get(m);
      if (!bySource) {
        bySource = new Map();
        minutes.set(m, bySource);
      }
      const existing = bySource.get(sample.source.id);
      if (existing) {
        existing.steps += share;
      } else {
        bySource.set(sample.source.id, {
          source: sample.source,
          steps: share,
        });
      }
    }
  }
  return minutes;
}

function pickWinner(
  contributions: MinuteContribution[],
  config: DedupConfig,
): MinuteContribution {
  if (contributions.length === 1) return contributions[0]!;
  if (config.stepsStrategy === "priority") {
    // Lowest rank wins; among unlisted (equal-rank) sources fall back to max.
    let best = contributions[0]!;
    for (const c of contributions.slice(1)) {
      const rc = priorityRank(config, c.source.id);
      const rb = priorityRank(config, best.source.id);
      if (rc < rb || (rc === rb && c.steps > best.steps)) best = c;
    }
    return best;
  }
  // "max": trust the device that saw the most steps this minute.
  return contributions.reduce((a, b) => (b.steps > a.steps ? b : a));
}

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
  const rawTotal = samples.reduce((sum, s) => sum + s.steps, 0);
  const minutes = sliceIntoMinutes(samples);

  // Resolve each minute to a single winning contribution.
  const wonMinutes: { minute: number; winner: MinuteContribution }[] = [];
  for (const [minute, bySource] of minutes) {
    const winner = pickWinner([...bySource.values()], config);
    wonMinutes.push({ minute, winner });
  }
  wonMinutes.sort((a, b) => a.minute - b.minute);

  // Re-aggregate consecutive minutes won by the same source.
  const out: StepsSample[] = [];
  let run: { source: SourceRef; startMinute: number; endMinute: number; steps: number } | null =
    null;
  const flush = () => {
    if (!run) return;
    const steps = Math.round(run.steps);
    if (steps > 0) {
      out.push({
        type: "steps",
        start: run.startMinute * MINUTE_MS,
        end: (run.endMinute + 1) * MINUTE_MS,
        steps,
        source: run.source,
      });
    }
    run = null;
  };
  for (const { minute, winner } of wonMinutes) {
    if (
      run &&
      run.source.id === winner.source.id &&
      minute === run.endMinute + 1
    ) {
      run.steps += winner.steps;
      run.endMinute = minute;
    } else {
      flush();
      run = {
        source: winner.source,
        startMinute: minute,
        endMinute: minute,
        steps: winner.steps,
      };
    }
  }
  flush();

  const total = out.reduce((sum, s) => sum + s.steps, 0);
  return { samples: out, total, rawTotal };
}

/** Convenience: canonical daily total for a set of samples (UTC day). */
export function totalSteps(deduped: DedupedSteps): number {
  return deduped.total;
}

export { MINUTE_MS };
export type { EpochMs };
