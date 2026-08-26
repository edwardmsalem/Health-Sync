/**
 * Generic minute-level source arbitration for cumulative interval series.
 *
 * This is the core overlap logic shared by steps and every other cumulative
 * metric (distance, calories, floors, hydration, ...): slice samples onto a
 * minute-resolution timeline with proportional allocation, let exactly one
 * source win each contested minute, then re-aggregate winning runs.
 * See dedup/steps.ts for the full rationale.
 */

import type { SourceRef, EpochMs } from "../types.js";
import { DedupConfig, priorityRank } from "../config.js";

export const MINUTE_MS = 60_000;

/**
 * Longest span a re-aggregated run may cover.
 *
 * Coalescing consecutive winning minutes keeps the canonical timeline tidy,
 * but for a dense series it merges genuinely separate events into one huge
 * sample: an hour of insulin temp basals became a single multi-unit "dose"
 * larger than anything actually delivered. Totals stayed right, individual
 * records did not — and a record read back for a dosing decision has to be
 * right on its own, not just in aggregate. Capping bounds that distortion.
 */
export const MAX_RUN_MS = 60 * MINUTE_MS;

export interface SeriesSample {
  start: EpochMs;
  end: EpochMs;
  value: number;
  source: SourceRef;
}

interface MinuteContribution {
  source: SourceRef;
  value: number;
}

/** Per-minute contributions, keyed by minute index (epochMs / 60000). */
type MinuteMap = Map<number, Map<string, MinuteContribution>>;

function sliceIntoMinutes(samples: SeriesSample[]): MinuteMap {
  const minutes: MinuteMap = new Map();
  for (const sample of samples) {
    const span = sample.end - sample.start;
    if (span <= 0 || sample.value <= 0) continue;
    const firstMinute = Math.floor(sample.start / MINUTE_MS);
    const lastMinute = Math.floor((sample.end - 1) / MINUTE_MS);
    for (let m = firstMinute; m <= lastMinute; m++) {
      const minuteStart = m * MINUTE_MS;
      const minuteEnd = minuteStart + MINUTE_MS;
      const overlap =
        Math.min(sample.end, minuteEnd) - Math.max(sample.start, minuteStart);
      const share = (sample.value * overlap) / span;
      if (share <= 0) continue;
      let bySource = minutes.get(m);
      if (!bySource) {
        bySource = new Map();
        minutes.set(m, bySource);
      }
      const existing = bySource.get(sample.source.id);
      if (existing) {
        existing.value += share;
      } else {
        bySource.set(sample.source.id, { source: sample.source, value: share });
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
      if (rc < rb || (rc === rb && c.value > best.value)) best = c;
    }
    return best;
  }
  // "max": trust the device that saw the most this minute.
  return contributions.reduce((a, b) => (b.value > a.value ? b : a));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface DedupedSeries {
  /** Canonical, non-overlapping samples (minute-aligned). */
  samples: SeriesSample[];
  total: number;
  /** Sum of raw input values, for reporting removed double counting. */
  rawTotal: number;
}

export function dedupeSeries(
  samples: SeriesSample[],
  config: DedupConfig,
): DedupedSeries {
  const rawTotal = round2(samples.reduce((sum, s) => sum + s.value, 0));
  const minutes = sliceIntoMinutes(samples);

  const wonMinutes: { minute: number; winner: MinuteContribution }[] = [];
  for (const [minute, bySource] of minutes) {
    wonMinutes.push({ minute, winner: pickWinner([...bySource.values()], config) });
  }
  wonMinutes.sort((a, b) => a.minute - b.minute);

  // Re-aggregate consecutive minutes won by the same source.
  const out: SeriesSample[] = [];
  let run: {
    source: SourceRef;
    startMinute: number;
    endMinute: number;
    value: number;
  } | null = null;
  const flush = () => {
    if (!run) return;
    const value = round2(run.value);
    if (value > 0) {
      out.push({
        start: run.startMinute * MINUTE_MS,
        end: (run.endMinute + 1) * MINUTE_MS,
        value,
        source: run.source,
      });
    }
    run = null;
  };
  for (const { minute, winner } of wonMinutes) {
    const wouldSpan = (minute + 1 - (run?.startMinute ?? minute)) * MINUTE_MS;
    if (
      run &&
      run.source.id === winner.source.id &&
      minute === run.endMinute + 1 &&
      wouldSpan <= MAX_RUN_MS
    ) {
      run.value += winner.value;
      run.endMinute = minute;
    } else {
      flush();
      run = {
        source: winner.source,
        startMinute: minute,
        endMinute: minute,
        value: winner.value,
      };
    }
  }
  flush();

  const total = round2(out.reduce((sum, s) => sum + s.value, 0));
  return { samples: out, total, rawTotal };
}

/** Minute indices that have any coverage from the given intervals. */
export function coveredMinutes(
  intervals: { start: EpochMs; end: EpochMs }[],
): Set<number> {
  const covered = new Set<number>();
  for (const s of intervals) {
    if (s.end <= s.start) continue;
    const first = Math.floor(s.start / MINUTE_MS);
    const last = Math.floor((s.end - 1) / MINUTE_MS);
    for (let m = first; m <= last; m++) covered.add(m);
  }
  return covered;
}

/**
 * Trim a canonical (minute-aligned) sample down to the minutes NOT in
 * `covered`, splitting into contiguous runs with proportional values.
 */
export function trimToGaps(
  sample: SeriesSample,
  covered: Set<number>,
): SeriesSample[] {
  const span = sample.end - sample.start;
  if (span <= 0) return [];
  const first = Math.floor(sample.start / MINUTE_MS);
  const last = Math.floor((sample.end - 1) / MINUTE_MS);
  const perMinute = sample.value / (last - first + 1);
  const out: SeriesSample[] = [];
  let run: { startMinute: number; endMinute: number; value: number } | null =
    null;
  const flush = () => {
    if (!run) return;
    const value = round2(run.value);
    if (value > 0) {
      out.push({
        ...sample,
        start: run.startMinute * MINUTE_MS,
        end: (run.endMinute + 1) * MINUTE_MS,
        value,
      });
    }
    run = null;
  };
  for (let m = first; m <= last; m++) {
    if (covered.has(m)) {
      flush();
      continue;
    }
    if (run && m === run.endMinute + 1) {
      run.endMinute = m;
      run.value += perMinute;
    } else {
      flush();
      run = { startMinute: m, endMinute: m, value: perMinute };
    }
  }
  flush();
  return out;
}
