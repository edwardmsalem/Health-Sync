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

/**
 * Treatments -> engine records.
 *
 * Temp basals need care. AAPS issues a temp basal with a nominal duration
 * (often 30 min) and then REPLACES it minutes later with a new one as the
 * loop re-decides. The declared duration is therefore an upper bound, not
 * what was delivered: taking it at face value over-counts basal insulin by
 * the whole overlap. Each temp basal is truncated at the start of the next
 * one, so only insulin that was actually delivered is recorded. A duration
 * of 0 is AAPS cancelling the running temp basal, and ends it there.
 */
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
  }

  // Temp basals, resolved against each other in time order.
  const basals = treatments
    .filter((t) => t.eventType === "Temp Basal" && t.created_at)
    .map((t) => ({
      start: Date.parse(t.created_at!),
      rate: t.rate ?? t.absolute,
      durationMin: t.duration,
    }))
    .filter(
      (b): b is { start: number; rate: number; durationMin: number } =>
        !Number.isNaN(b.start) &&
        typeof b.rate === "number" &&
        b.rate > 0 &&
        typeof b.durationMin === "number",
    )
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < basals.length; i++) {
    const b = basals[i]!;
    const declaredEnd = b.start + b.durationMin * 60_000;
    // Superseded by the next temp basal, if that arrives first.
    const next = basals[i + 1]?.start ?? declaredEnd;
    const end = Math.min(declaredEnd, next);
    const deliveredMs = end - b.start;
    if (deliveredMs <= 0) continue;
    const units = (b.rate * deliveredMs) / 3_600_000;
    if (units <= 0) continue;
    out.push({
      type: "cumulative",
      metric: "insulin_basal_units",
      value: Math.round(units * 1000) / 1000,
      start: b.start,
      end,
      source: AAPS_SOURCE,
    });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}
