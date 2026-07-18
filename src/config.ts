/** Configuration for dedup + sync behavior. */

export type StepsWinnerStrategy =
  /**
   * When multiple devices recorded steps in the same minute, the device
   * earliest in `devicePriority` wins the whole minute. Devices not listed
   * fall back to "max".
   */
  | "priority"
  /** The device that recorded the most steps in that minute wins it. */
  | "max";

export interface DedupConfig {
  /**
   * Ordered list of source ids, most-trusted first,
   * e.g. ["apple-watch", "fitbit-air", "iphone", "pixel"].
   * Wrist wearables should generally outrank phones (phones miss steps when
   * left on a desk).
   */
  devicePriority: string[];
  /** How to pick the winning device for a contested minute of steps. */
  stepsStrategy: StepsWinnerStrategy;
  /**
   * Two sleep sessions are considered the same night's sleep (and deduped)
   * when they overlap at all. After trimming a losing session to its
   * non-overlapping remainder, fragments shorter than this are discarded as
   * noise. Default: 15 minutes.
   */
  minSleepFragmentMs: number;
  /**
   * Two workouts are treated as duplicates when their intervals overlap by
   * more than this fraction of the shorter workout. Default: 0.5.
   */
  workoutOverlapThreshold: number;
}

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  devicePriority: [],
  stepsStrategy: "max",
  minSleepFragmentMs: 15 * 60 * 1000,
  workoutOverlapThreshold: 0.5,
};

/**
 * Rank of a source id in the priority list; lower is better.
 * Unlisted sources rank below all listed ones.
 */
export function priorityRank(config: DedupConfig, sourceId: string): number {
  const idx = config.devicePriority.indexOf(sourceId);
  return idx === -1 ? config.devicePriority.length : idx;
}
