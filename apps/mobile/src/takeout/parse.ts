/**
 * Pure parsers for a Google Takeout export of Fitbit / Google Health data.
 *
 * Why files instead of an API: Fitbit's legacy Web API is being retired
 * (Sept 2026) and new app registration for it is closed, while the
 * replacement Google Health API needs a Cloud project, Restricted-scope
 * review, and re-auth every 7 days in testing mode. Takeout hands over the
 * same data — including minute-level steps and heart rate, and sleep with
 * stages — as plain JSON with no API, no OAuth, and no rate limits.
 *
 * Layout (Takeout/Fitbit/...), with per-day or per-chunk files:
 *   Global Export Data/steps-YYYY-MM-DD.json       [{dateTime, value}]
 *   Global Export Data/distance-YYYY-MM-DD.json    [{dateTime, value}]  (cm)
 *   Global Export Data/calories-YYYY-MM-DD.json    [{dateTime, value}]
 *   Global Export Data/heart_rate-YYYY-MM-DD.json  [{dateTime, value:{bpm}}]
 *   Global Export Data/sleep-YYYY-MM-DD.json       [{startTime, endTime, levels}]
 *
 * Timestamps in these files are LOCAL wall-clock with no offset, in
 * "MM/dd/yy HH:mm:ss" form (sleep uses ISO-like local strings), so the
 * caller supplies the UTC offset to interpret them — same approach as the
 * Fitbit API parsers.
 */

import type {
  CumulativeSample,
  HealthRecord,
  PointSample,
  SleepSession,
  SleepStageInterval,
  SourceRef,
  StepsSample,
} from "health-sync";

export const TAKEOUT_SOURCE: SourceRef = {
  id: "fitbit",
  name: "Fitbit (Takeout)",
  platform: "google",
};

const MINUTE_MS = 60_000;

/**
 * Parse Fitbit's export timestamp to epoch ms.
 * Accepts "MM/dd/yy HH:mm:ss" (Global Export Data) and ISO-like local
 * strings such as "2026-07-17T23:00:00.000" (sleep logs).
 */
export function parseTakeoutTime(raw: string, utcOffsetMs: number): number | null {
  const s = raw.trim();
  const us = s.match(/^(\d{2})\/(\d{2})\/(\d{2,4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (us) {
    const [, mm, dd, yy, hh, mi, ss] = us;
    const year = yy!.length === 2 ? 2000 + Number(yy) : Number(yy);
    return Date.UTC(year, Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss)) - utcOffsetMs;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (iso) {
    const [, y, mo, d, hh, mi, ss] = iso;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss)) - utcOffsetMs;
  }
  return null;
}

interface RawEntry {
  dateTime?: string;
  value?: unknown;
}

/** Merge consecutive minute buckets from the same series into runs. */
function coalesce<T extends { start: number; end: number; value: number }>(
  points: { at: number; value: number }[],
): T[] {
  const out: T[] = [];
  let run: { start: number; end: number; value: number } | null = null;
  for (const p of points.sort((a, b) => a.at - b.at)) {
    if (run && p.at === run.end) {
      run.end = p.at + MINUTE_MS;
      run.value += p.value;
    } else {
      if (run) out.push(run as T);
      run = { start: p.at, end: p.at + MINUTE_MS, value: p.value };
    }
  }
  if (run) out.push(run as T);
  return out;
}

function numericValue(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseStepsFile(entries: RawEntry[], utcOffsetMs: number): StepsSample[] {
  const points: { at: number; value: number }[] = [];
  for (const e of entries ?? []) {
    if (!e?.dateTime) continue;
    const at = parseTakeoutTime(e.dateTime, utcOffsetMs);
    const v = numericValue(e.value);
    if (at === null || v === null || v <= 0) continue;
    points.push({ at, value: v });
  }
  return coalesce(points).map((r) => ({
    type: "steps" as const,
    source: TAKEOUT_SOURCE,
    start: r.start,
    end: r.end,
    steps: Math.round(r.value),
  }));
}

export function parseCumulativeFile(
  entries: RawEntry[],
  utcOffsetMs: number,
  metric: CumulativeSample["metric"],
  scale: number,
): CumulativeSample[] {
  const points: { at: number; value: number }[] = [];
  for (const e of entries ?? []) {
    if (!e?.dateTime) continue;
    const at = parseTakeoutTime(e.dateTime, utcOffsetMs);
    const v = numericValue(e.value);
    if (at === null || v === null || v <= 0) continue;
    points.push({ at, value: v * scale });
  }
  return coalesce(points).map((r) => ({
    type: "cumulative" as const,
    metric,
    source: TAKEOUT_SOURCE,
    start: r.start,
    end: r.end,
    value: Math.round(r.value * 100) / 100,
  }));
}

export function parseHeartRateFile(entries: RawEntry[], utcOffsetMs: number): PointSample[] {
  const out: PointSample[] = [];
  for (const e of entries ?? []) {
    if (!e?.dateTime) continue;
    const at = parseTakeoutTime(e.dateTime, utcOffsetMs);
    if (at === null) continue;
    const raw = e.value as { bpm?: unknown } | unknown;
    const bpm =
      raw && typeof raw === "object" && "bpm" in (raw as object)
        ? numericValue((raw as { bpm: unknown }).bpm)
        : numericValue(raw);
    if (bpm === null || bpm <= 0) continue;
    out.push({
      type: "point",
      metric: "heart_rate_bpm",
      source: TAKEOUT_SOURCE,
      start: at,
      end: at,
      value: bpm,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

const SLEEP_LEVELS: Record<string, SleepStageInterval["stage"]> = {
  deep: "deep",
  light: "light",
  rem: "rem",
  wake: "awake",
  awake: "awake",
  asleep: "asleep",
  restless: "light",
  restful: "light",
};

export interface TakeoutSleepLog {
  logId?: number;
  startTime?: string;
  endTime?: string;
  levels?: { data?: { dateTime: string; level: string; seconds: number }[] };
}

export function parseSleepFile(logs: TakeoutSleepLog[], utcOffsetMs: number): SleepSession[] {
  const out: SleepSession[] = [];
  for (const log of logs ?? []) {
    if (!log?.startTime || !log?.endTime) continue;
    const start = parseTakeoutTime(log.startTime, utcOffsetMs);
    const end = parseTakeoutTime(log.endTime, utcOffsetMs);
    if (start === null || end === null || end <= start) continue;
    const stages: SleepStageInterval[] = [];
    for (const d of log.levels?.data ?? []) {
      const stage = SLEEP_LEVELS[String(d.level).toLowerCase()];
      const at = parseTakeoutTime(d.dateTime, utcOffsetMs);
      if (!stage || at === null || !Number.isFinite(d.seconds)) continue;
      stages.push({ stage, start: at, end: at + d.seconds * 1000 });
    }
    out.push({
      type: "sleep",
      source: TAKEOUT_SOURCE,
      nativeId: log.logId !== undefined ? String(log.logId) : undefined,
      start,
      end,
      stages: stages.length ? stages : [{ stage: "asleep", start, end }],
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Which parser a Takeout filename maps to. */
/**
 * Which parser a Takeout filename maps to.
 *
 * Names are matched on a normalized basename ("steps-2026-07-17.json" ->
 * "steps"), tolerating the "-", "_" and " " separators Google has used, so
 * the importer survives cosmetic renames from the Fitbit -> Google Health
 * rebrand. Matching is deliberately anchored at the start and requires the
 * separator, so neighbours like "sleep_score-*.json" or "steps_goal-*.json"
 * are NOT mistaken for time-series files.
 */
export function classifyTakeoutFile(path: string):
  | { kind: "steps" }
  | { kind: "cumulative"; metric: CumulativeSample["metric"]; scale: number }
  | { kind: "heart_rate" }
  | { kind: "sleep" }
  | null {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (!base.endsWith(".json")) return null;

  // "steps-2026-07-17.json" / "steps_2026_07.json" -> "steps"
  const stem = base.slice(0, -".json".length);
  const prefix = stem.split(/[-_ ]\d/)[0]?.replace(/[-_ ]+$/, "") ?? "";

  switch (prefix) {
    case "steps":
      return { kind: "steps" };
    // Takeout distance is in centimetres.
    case "distance":
      return { kind: "cumulative", metric: "distance_m", scale: 0.01 };
    case "calories":
      return { kind: "cumulative", metric: "active_energy_kcal", scale: 1 };
    case "heart_rate":
    case "heartrate":
      return { kind: "heart_rate" };
    case "sleep":
      return { kind: "sleep" };
    default:
      return null;
  }
}

/** Parse one Takeout JSON file into engine records. Unknown files -> []. */
export function parseTakeoutFile(
  path: string,
  json: unknown,
  utcOffsetMs: number,
): HealthRecord[] {
  const kind = classifyTakeoutFile(path);
  if (!kind || !Array.isArray(json)) return [];
  switch (kind.kind) {
    case "steps":
      return parseStepsFile(json as RawEntry[], utcOffsetMs);
    case "cumulative":
      return parseCumulativeFile(json as RawEntry[], utcOffsetMs, kind.metric, kind.scale);
    case "heart_rate":
      return parseHeartRateFile(json as RawEntry[], utcOffsetMs);
    case "sleep":
      return parseSleepFile(json as TakeoutSleepLog[], utcOffsetMs);
  }
}
