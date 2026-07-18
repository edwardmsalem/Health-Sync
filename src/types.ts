/**
 * Normalized health data model shared by all providers.
 *
 * Every record carries a `source` describing the device/app that originally
 * recorded it. The dedup engine uses sources to decide which record wins when
 * two devices (e.g. Apple Watch + Fitbit) measured the same real-world
 * activity, and the sync engine uses them to prevent echo loops.
 */

/** Epoch milliseconds. All timestamps in the engine are UTC epoch ms. */
export type EpochMs = number;

/** The platform a record lives on (or came from). */
export type Platform = "apple" | "google";

/** Identifies the device / app that originally recorded a sample. */
export interface SourceRef {
  /**
   * Stable identifier for the recording origin, e.g. "apple-watch",
   * "fitbit-air", "iphone", "pixel". Used for priority ranking, so the same
   * physical device should map to the same id on both platforms.
   */
  id: string;
  /** Human readable name, e.g. "Edward's Apple Watch". */
  name?: string;
  /** Platform the record was read from. */
  platform: Platform;
}

/** Marker metadata we attach to every record we write, to prevent echo loops. */
export const SYNC_ORIGIN_PREFIX = "health-sync:";

export interface BaseRecord {
  /** Provider-native record id, when the platform exposes one. */
  nativeId?: string;
  start: EpochMs;
  end: EpochMs;
  source: SourceRef;
  /**
   * External/client id present on the record. Records written by this engine
   * are tagged `health-sync:<fingerprint>` so they can be recognized (and
   * skipped) when read back on a later sync.
   */
  externalId?: string;
}

/** A bucketed step count sample, e.g. "531 steps from 09:00 to 09:15". */
export interface StepsSample extends BaseRecord {
  type: "steps";
  steps: number;
}

export type SleepStage =
  | "awake"
  | "light"
  | "deep"
  | "rem"
  | "asleep" // unspecified stage (older devices)
  | "in_bed";

export interface SleepStageInterval {
  stage: SleepStage;
  start: EpochMs;
  end: EpochMs;
}

/** A sleep session: an overall interval plus optional stage breakdown. */
export interface SleepSession extends BaseRecord {
  type: "sleep";
  stages: SleepStageInterval[];
}

export interface WorkoutRecord extends BaseRecord {
  type: "workout";
  /** Normalized activity, e.g. "running", "cycling", "strength_training". */
  activity: string;
  activeEnergyKcal?: number;
  distanceMeters?: number;
}

/**
 * Cumulative interval metrics: a quantity accumulated over a time span.
 * Two devices measuring the same span double-count when summed, so these get
 * the same minute-level source arbitration as steps.
 * Known metrics are listed for autocomplete; any string is accepted so
 * providers can pass through platform-specific types.
 */
export type CumulativeMetric =
  | "distance_m"
  | "active_energy_kcal"
  | "basal_energy_kcal"
  | "floors_climbed"
  | "elevation_gained_m"
  | "exercise_minutes"
  | "hydration_ml"
  | "dietary_energy_kcal"
  | (string & {});

export interface CumulativeSample extends BaseRecord {
  type: "cumulative";
  metric: CumulativeMetric;
  value: number;
}

/**
 * Point-in-time metrics: an instantaneous reading. Duplicates don't inflate
 * sums (platforms average them), but two devices sampling the same moment
 * still pollute series, so near-simultaneous readings from different sources
 * are deduped by device priority.
 */
export type PointMetric =
  | "heart_rate_bpm"
  | "resting_heart_rate_bpm"
  | "hrv_sdnn_ms"
  | "blood_oxygen_pct"
  | "respiratory_rate_bpm"
  | "vo2_max"
  | "body_temperature_c"
  | "weight_kg"
  | "body_fat_pct"
  | "height_m"
  | "blood_glucose_mgdl"
  | "blood_pressure_systolic_mmhg"
  | "blood_pressure_diastolic_mmhg"
  | (string & {});

export interface PointSample extends BaseRecord {
  type: "point";
  metric: PointMetric;
  value: number;
}

export type HealthRecord =
  | StepsSample
  | SleepSession
  | WorkoutRecord
  | CumulativeSample
  | PointSample;

export type RecordType = HealthRecord["type"];

export interface TimeRange {
  start: EpochMs;
  end: EpochMs;
}

/** True if the record was written by this sync engine (not device-native). */
export function isSyncAuthored(record: BaseRecord): boolean {
  return record.externalId?.startsWith(SYNC_ORIGIN_PREFIX) ?? false;
}

export function durationMs(r: TimeRange): number {
  return Math.max(0, r.end - r.start);
}

export function overlapMs(a: TimeRange, b: TimeRange): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return overlapMs(a, b) > 0;
}

/**
 * Whether a record falls inside a query range. Unlike `overlaps`, this
 * handles instantaneous records (point samples, where start === end), which
 * have no duration to overlap with.
 */
export function intersectsRange(r: TimeRange, range: TimeRange): boolean {
  if (r.start === r.end) return r.start >= range.start && r.start < range.end;
  return overlaps(r, range);
}
