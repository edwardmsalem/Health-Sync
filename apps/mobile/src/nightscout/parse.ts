/**
 * Pure parsers: Nightscout REST responses -> engine records.
 *
 * AAPS uploads to Nightscout:
 *   - entries (sgv):   CGM glucose, every ~5 min, mg/dL, epoch ms `date`
 *   - treatments:      boluses (`insulin` units), carbs (`carbs` g), and
 *                      temp basals (`rate` U/h + `duration` min)
 *
 * Mapping into the hub:
 *   - glucose  -> point  blood_glucose_mgdl
 *   - bolus    -> point  insulin_bolus_units
 *   - carbs    -> point  carbs_g
 *   - temp basal -> cumulative insulin_basal_units over its interval
 *     (delivered units = rate * duration; AAPS closed-loop adjusts rate
 *     every few minutes, so segments are short and the sum is faithful)
 */

import type { CumulativeSample, PointSample, SourceRef } from "health-sync";

export const AAPS_SOURCE: SourceRef = {
  id: "aaps",
  name: "AndroidAPS (Nightscout)",
  platform: "nightscout",
};

export interface NightscoutEntry {
  /** Sensor glucose value, mg/dL. */
  sgv?: number;
  /** Epoch ms. */
  date?: number;
  type?: string;
}

export interface NightscoutTreatment {
  eventType?: string;
  created_at?: string;
  insulin?: number | null;
  carbs?: number | null;
  /** Temp basal rate, U/h. */
  rate?: number;
  /** Temp basal absolute rate, U/h (older AAPS field). */
  absolute?: number;
  /** Minutes. */
  duration?: number;
}

export function parseEntries(entries: NightscoutEntry[]): PointSample[] {
  const out: PointSample[] = [];
  for (const e of entries) {
    if (typeof e.sgv !== "number" || e.sgv <= 0 || typeof e.date !== "number") continue;
    out.push({
      type: "point",
      metric: "blood_glucose_mgdl",
      value: e.sgv,
      start: e.date,
      end: e.date,
      source: AAPS_SOURCE,
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export function parseTreatments(
  treatments: NightscoutTreatment[],
): (PointSample | CumulativeSample)[] {
  const out: (PointSample | CumulativeSample)[] = [];
  for (const t of treatments) {
    if (!t.created_at) continue;
    const at = Date.parse(t.created_at);
    if (Number.isNaN(at)) continue;

    if (typeof t.insulin === "number" && t.insulin > 0) {
      out.push({
        type: "point",
        metric: "insulin_bolus_units",
        value: t.insulin,
        start: at,
        end: at,
        source: AAPS_SOURCE,
      });
    }
    if (typeof t.carbs === "number" && t.carbs > 0) {
      out.push({
        type: "point",
        metric: "carbs_g",
        value: t.carbs,
        start: at,
        end: at,
        source: AAPS_SOURCE,
      });
    }
    const rate = t.rate ?? t.absolute;
    if (
      t.eventType === "Temp Basal" &&
      typeof rate === "number" &&
      rate > 0 &&
      typeof t.duration === "number" &&
      t.duration > 0
    ) {
      const durationMs = t.duration * 60_000;
      const units = (rate * t.duration) / 60;
      out.push({
        type: "cumulative",
        metric: "insulin_basal_units",
        value: Math.round(units * 1000) / 1000,
        start: at,
        end: at + durationMs,
        source: AAPS_SOURCE,
      });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
