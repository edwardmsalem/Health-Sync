/**
 * Overlap-aware dedup for all cumulative interval metrics (distance,
 * calories, floors climbed, hydration, ...). Each metric gets its own
 * independent minute-arbitration pass — two devices measuring the same
 * minutes contribute one winner, never a sum. Same engine as steps.
 */

import type { CumulativeSample } from "../types.js";
import { DedupConfig } from "../config.js";
import { dedupeSeries } from "./series.js";

export interface DedupedCumulative {
  samples: CumulativeSample[];
  /** Per-metric totals after and before dedup. */
  totals: Record<string, { total: number; rawTotal: number }>;
}

export function dedupeCumulative(
  samples: CumulativeSample[],
  config: DedupConfig,
): DedupedCumulative {
  const byMetric = new Map<string, CumulativeSample[]>();
  for (const s of samples) {
    const list = byMetric.get(s.metric) ?? [];
    list.push(s);
    byMetric.set(s.metric, list);
  }

  const out: CumulativeSample[] = [];
  const totals: DedupedCumulative["totals"] = {};
  for (const [metric, group] of byMetric) {
    const result = dedupeSeries(
      group.map((s) => ({
        start: s.start,
        end: s.end,
        value: s.value,
        source: s.source,
      })),
      config,
    );
    for (const s of result.samples) {
      out.push({
        type: "cumulative",
        metric,
        start: s.start,
        end: s.end,
        value: s.value,
        source: s.source,
      });
    }
    totals[metric] = { total: result.total, rawTotal: result.rawTotal };
  }
  out.sort((a, b) => a.start - b.start);
  return { samples: out, totals };
}
