/**
 * Dedup for point-in-time metrics (heart rate, weight, SpO2, HRV, glucose,
 * blood pressure, ...).
 *
 * Unlike cumulative metrics, duplicate points don't inflate totals — but two
 * devices sampling the same moment still pollute the series (e.g. Watch and
 * Fitbit both logging heart rate all night). Rule: a reading from a
 * lower-priority source is dropped when a higher-priority source already has
 * a reading of the same metric within `pointToleranceMs`. Readings from the
 * SAME source are never deduped against each other — a device's own series
 * is always legitimate.
 */

import type { PointSample } from "../types.js";
import { DedupConfig, priorityRank } from "../config.js";

/** Binary search: is there a value in sorted `times` within `tol` of `t`? */
function hasNear(times: number[], t: number, tol: number): boolean {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  const before = times[lo - 1];
  const after = times[lo];
  return (
    (before !== undefined && t - before <= tol) ||
    (after !== undefined && after - t <= tol)
  );
}

export interface DedupedPoints {
  points: PointSample[];
  dropped: PointSample[];
}

export function dedupePoints(
  samples: PointSample[],
  config: DedupConfig,
): DedupedPoints {
  const byMetric = new Map<string, PointSample[]>();
  for (const s of samples) {
    const list = byMetric.get(s.metric) ?? [];
    list.push(s);
    byMetric.set(s.metric, list);
  }

  const kept: PointSample[] = [];
  const dropped: PointSample[] = [];

  for (const group of byMetric.values()) {
    // Bucket by source, then process sources best-first.
    const bySource = new Map<string, PointSample[]>();
    for (const s of group) {
      const list = bySource.get(s.source.id) ?? [];
      list.push(s);
      bySource.set(s.source.id, list);
    }
    const sources = [...bySource.entries()].sort(
      (a, b) => priorityRank(config, a[0]) - priorityRank(config, b[0]),
    );

    // Times already claimed by better sources; a source's own samples are
    // only merged in AFTER the whole source is processed, so a device never
    // dedupes against itself.
    let claimed: number[] = [];
    for (const [, sourceSamples] of sources) {
      sourceSamples.sort((a, b) => a.start - b.start);
      for (const s of sourceSamples) {
        if (hasNear(claimed, s.start, config.pointToleranceMs)) {
          dropped.push(s);
        } else {
          kept.push(s);
        }
      }
      claimed = [...claimed, ...sourceSamples.map((s) => s.start)].sort(
        (a, b) => a - b,
      );
    }
  }

  kept.sort((a, b) => a.start - b.start);
  return { points: kept, dropped };
}
