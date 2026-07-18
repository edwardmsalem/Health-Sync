/**
 * Pure parsers: Fitbit Web API responses -> engine records.
 *
 * Fitbit's intraday/sleep endpoints return LOCAL times with no offset; the
 * caller passes the account's UTC offset (from the profile endpoint,
 * `offsetFromUTCMillis`) so parsing stays pure and testable.
 */

import type {
  CumulativeSample,
  HealthRecord,
  PointSample,
  SleepSession,
  SleepStage,
  SleepStageInterval,
  SourceRef,
  StepsSample,
  WorkoutRecord,
} from "health-sync";
import { normalizeActivityName } from "../healthkit/mapping.ts";

export const FITBIT_SOURCE: SourceRef = {
  id: "fitbit",
  name: "Fitbit",
  platform: "google",
};

const MINUTE_MS = 60_000;

/** Epoch ms of local midnight for a Fitbit "yyyy-MM-dd" date string. */
export function dayStartMs(date: string, utcOffsetMs: number): number {
  return Date.parse(`${date}T00:00:00Z`) - utcOffsetMs;
}

/** Parse a Fitbit local timestamp "2026-07-16T23:00:00.000" to epoch ms. */
export function localTimeMs(local: string, utcOffsetMs: number): number {
  const iso = local.includes(".") ? local : `${local}.000`;
  return Date.parse(`${iso}Z`) - utcOffsetMs;
}

interface IntradayDataset {
  dataset: { time: string; value: number }[];
}

function intradayPointMs(date: string, time: string, utcOffsetMs: number): number {
  const [h, m, s] = time.split(":").map(Number);
  return dayStartMs(date, utcOffsetMs) + ((h! * 60 + m!) * 60 + (s ?? 0)) * 1000;
}

/**
 * Intraday steps (1-min detail) -> minute samples. Zero minutes are skipped;
 * consecutive active minutes are merged into contiguous samples.
 */
export function parseIntradaySteps(
  date: string,
  intraday: IntradayDataset,
  utcOffsetMs: number,
): StepsSample[] {
  const out: StepsSample[] = [];
  let run: { start: number; end: number; steps: number } | null = null;
  for (const p of intraday.dataset) {
    const at = intradayPointMs(date, p.time, utcOffsetMs);
    if (p.value <= 0) continue;
    if (run && at === run.end) {
      run.end = at + MINUTE_MS;
      run.steps += p.value;
    } else {
      if (run) out.push({ type: "steps", source: FITBIT_SOURCE, ...run });
      run = { start: at, end: at + MINUTE_MS, steps: p.value };
    }
  }
  if (run) out.push({ type: "steps", source: FITBIT_SOURCE, ...run });
  return out;
}

/** Intraday distance (km) / calories -> cumulative samples, merged like steps. */
export function parseIntradayCumulative(
  date: string,
  intraday: IntradayDataset,
  utcOffsetMs: number,
  metric: CumulativeSample["metric"],
  scale: number,
): CumulativeSample[] {
  const out: CumulativeSample[] = [];
  let run: { start: number; end: number; value: number } | null = null;
  for (const p of intraday.dataset) {
    const at = intradayPointMs(date, p.time, utcOffsetMs);
    const value = p.value * scale;
    if (value <= 0) continue;
    if (run && at === run.end) {
      run.end = at + MINUTE_MS;
      run.value += value;
    } else {
      if (run) out.push({ type: "cumulative", metric, source: FITBIT_SOURCE, ...run });
      run = { start: at, end: at + MINUTE_MS, value };
    }
  }
  if (run) out.push({ type: "cumulative", metric, source: FITBIT_SOURCE, ...run });
  return out.map((s) => ({ ...s, value: Math.round(s.value * 100) / 100 }));
}

/** Intraday heart rate -> point samples. */
export function parseIntradayHeartRate(
  date: string,
  intraday: IntradayDataset,
  utcOffsetMs: number,
): PointSample[] {
  return intraday.dataset
    .filter((p) => p.value > 0)
    .map((p) => {
      const at = intradayPointMs(date, p.time, utcOffsetMs);
      return {
        type: "point" as const,
        metric: "heart_rate_bpm" as const,
        source: FITBIT_SOURCE,
        start: at,
        end: at,
        value: p.value,
      };
    });
}

const FITBIT_SLEEP_LEVELS: Record<string, SleepStage> = {
  deep: "deep",
  light: "light",
  rem: "rem",
  wake: "awake",
  awake: "awake",
  asleep: "asleep",
  restless: "light",
};

export interface FitbitSleepLog {
  logId: number;
  startTime: string;
  endTime: string;
  levels?: { data?: { dateTime: string; level: string; seconds: number }[] };
}

export function parseSleepLogs(
  logs: FitbitSleepLog[],
  utcOffsetMs: number,
): (SleepSession & { logId: number })[] {
  return logs.map((log) => {
    const start = localTimeMs(log.startTime, utcOffsetMs);
    const end = localTimeMs(log.endTime, utcOffsetMs);
    const stages: SleepStageInterval[] = (log.levels?.data ?? [])
      .map((d) => {
        const stage = FITBIT_SLEEP_LEVELS[d.level];
        if (!stage) return null;
        const s = localTimeMs(d.dateTime, utcOffsetMs);
        return { stage, start: s, end: s + d.seconds * 1000 };
      })
      .filter((x): x is SleepStageInterval => x !== null);
    return {
      type: "sleep" as const,
      logId: log.logId,
      nativeId: String(log.logId),
      source: FITBIT_SOURCE,
      start,
      end,
      stages: stages.length ? stages : [{ stage: "asleep", start, end }],
    };
  });
}

export interface FitbitActivityLog {
  logId: number;
  activityName: string;
  /** ISO 8601 WITH offset, e.g. "2026-07-17T08:00:00.000-07:00". */
  startTime: string;
  duration: number;
  calories?: number;
  /** Kilometers. */
  distance?: number;
}

export function parseActivityLogs(
  logs: FitbitActivityLog[],
): (WorkoutRecord & { logId: number })[] {
  return logs.map((log) => {
    const start = Date.parse(log.startTime);
    return {
      type: "workout" as const,
      logId: log.logId,
      nativeId: String(log.logId),
      source: FITBIT_SOURCE,
      start,
      end: start + log.duration,
      activity: normalizeActivityName(log.activityName),
      activeEnergyKcal: log.calories,
      distanceMeters: log.distance !== undefined ? Math.round(log.distance * 1000) : undefined,
    };
  });
}

export interface FitbitWeightLog {
  logId: number;
  date: string;
  time: string;
  /** kg (request with units=METRIC). */
  weight: number;
  fat?: number;
}

export function parseWeightLogs(
  logs: FitbitWeightLog[],
  utcOffsetMs: number,
): (HealthRecord & { logId: number })[] {
  const out: (PointSample & { logId: number })[] = [];
  for (const log of logs) {
    const at = localTimeMs(`${log.date}T${log.time}`, utcOffsetMs);
    out.push({
      type: "point",
      logId: log.logId,
      nativeId: String(log.logId),
      metric: "weight_kg",
      source: { ...FITBIT_SOURCE, id: "fitbit-scale", name: "Fitbit weight log" },
      start: at,
      end: at,
      value: log.weight,
    });
    if (log.fat !== undefined) {
      out.push({
        type: "point",
        logId: log.logId,
        nativeId: String(log.logId),
        metric: "body_fat_pct",
        source: { ...FITBIT_SOURCE, id: "fitbit-scale", name: "Fitbit weight log" },
        start: at,
        end: at,
        value: log.fat,
      });
    }
  }
  return out;
}
