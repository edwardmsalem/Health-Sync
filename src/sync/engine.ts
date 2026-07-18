/**
 * Two-way smart sync engine.
 *
 * Each sync run:
 *   1. Reads the window from both platforms.
 *   2. Splits records into NATIVE (recorded by a device/app) vs SYNC-AUTHORED
 *      (written by us on a previous run, tagged via externalId). Only native
 *      records are inputs to the canonical timeline — this is what prevents
 *      echo loops and re-double-counting.
 *   3. Builds ONE canonical timeline per data type from the union of native
 *      records on both platforms, using the overlap-aware dedup engine
 *      (steps: minute arbitration; sleep: session clustering; workouts:
 *      overlap suppression).
 *   4. Diffs the canonical timeline against each platform: canonical records
 *      that did not originate there and haven't been written by us before are
 *      written, tagged `health-sync:<fingerprint>`. Stale sync-authored
 *      records (no longer part of the canonical timeline, e.g. because a
 *      better source arrived) are deleted.
 *
 * Running it twice is a no-op the second time (idempotent).
 */

import type {
  HealthRecord,
  Platform,
  StepsSample,
  SleepSession,
  WorkoutRecord,
  TimeRange,
} from "../types.js";
import { isSyncAuthored, overlaps, SYNC_ORIGIN_PREFIX } from "../types.js";
import type { HealthProvider } from "../providers/provider.js";
import { DedupConfig, DEFAULT_DEDUP_CONFIG } from "../config.js";
import { dedupeSteps, MINUTE_MS } from "../dedup/steps.js";
import { dedupeSleep } from "../dedup/sleep.js";
import { dedupeWorkouts, isDuplicateWorkout } from "../dedup/workouts.js";
import { fingerprint } from "./fingerprint.js";
import type { SyncLedger } from "./ledger.js";
import { InMemoryLedger } from "./ledger.js";

export interface SyncOptions {
  dedup?: Partial<DedupConfig>;
  ledger?: SyncLedger;
  /** Dry run: compute the plan but don't write/delete anything. */
  dryRun?: boolean;
}

export interface PlatformPlan {
  platform: Platform;
  writes: HealthRecord[];
  deletes: string[]; // externalIds of stale sync-authored records
}

export interface SyncReport {
  range: TimeRange;
  /** Canonical (deduped) record counts per type. */
  canonical: { steps: number; sleepSessions: number; workouts: number };
  /** Steps double counting removed: raw sum minus deduped total. */
  stepsDoubleCountRemoved: number;
  sleepDoubleCountRemovedMs: number;
  plans: PlatformPlan[];
}

/**
 * Trim canonical (minute-aligned) step samples down to the minutes NOT
 * covered by the target platform's own native step data. A minute with any
 * native contribution is considered covered — the platform already has a
 * measurement for it, and adding a second one would double count.
 */
export function fillStepGaps(
  canonical: StepsSample[],
  platformNative: StepsSample[],
): StepsSample[] {
  const covered = new Set<number>();
  for (const s of platformNative) {
    if (s.end <= s.start) continue;
    const first = Math.floor(s.start / MINUTE_MS);
    const last = Math.floor((s.end - 1) / MINUTE_MS);
    for (let m = first; m <= last; m++) covered.add(m);
  }

  const out: StepsSample[] = [];
  for (const sample of canonical) {
    const span = sample.end - sample.start;
    if (span <= 0) continue;
    const first = Math.floor(sample.start / MINUTE_MS);
    const last = Math.floor((sample.end - 1) / MINUTE_MS);
    const perMinute = sample.steps / ((last - first) + 1);
    let run: { startMinute: number; endMinute: number; steps: number } | null =
      null;
    const flush = () => {
      if (!run) return;
      const steps = Math.round(run.steps);
      if (steps > 0) {
        out.push({
          ...sample,
          start: run.startMinute * MINUTE_MS,
          end: (run.endMinute + 1) * MINUTE_MS,
          steps,
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
        run.steps += perMinute;
      } else {
        flush();
        run = { startMinute: m, endMinute: m, steps: perMinute };
      }
    }
    flush();
  }
  return out;
}

export class SyncEngine {
  private readonly config: DedupConfig;
  private readonly ledger: SyncLedger;
  private readonly dryRun: boolean;

  constructor(
    private readonly providers: HealthProvider[],
    options: SyncOptions = {},
  ) {
    if (providers.length < 2) {
      throw new Error("SyncEngine needs at least two providers");
    }
    const platforms = new Set(providers.map((p) => p.platform));
    if (platforms.size !== providers.length) {
      throw new Error("Each provider must be for a distinct platform");
    }
    this.config = { ...DEFAULT_DEDUP_CONFIG, ...options.dedup };
    this.ledger = options.ledger ?? new InMemoryLedger();
    this.dryRun = options.dryRun ?? false;
  }

  async sync(range: TimeRange): Promise<SyncReport> {
    // 1. Read everything from every platform.
    const reads = await Promise.all(
      this.providers.map(async (p) => ({
        provider: p,
        records: await p.read(range),
      })),
    );

    // 2. Separate native measurements from records we authored earlier.
    const native: HealthRecord[] = [];
    const authoredByPlatform = new Map<Platform, Set<string>>();
    const nativeByPlatform = new Map<Platform, HealthRecord[]>();
    for (const { provider, records } of reads) {
      const authored = new Set<string>();
      const platformNative: HealthRecord[] = [];
      authoredByPlatform.set(provider.platform, authored);
      nativeByPlatform.set(provider.platform, platformNative);
      for (const r of records) {
        if (isSyncAuthored(r)) {
          authored.add(r.externalId!);
        } else {
          native.push(r);
          platformNative.push(r);
        }
      }
    }

    // 3. Canonical timeline per data type (cross-platform, overlap-deduped).
    const steps = dedupeSteps(
      native.filter((r): r is StepsSample => r.type === "steps"),
      this.config,
    );
    const sleep = dedupeSleep(
      native.filter((r): r is SleepSession => r.type === "sleep"),
      this.config,
    );
    const workouts = dedupeWorkouts(
      native.filter((r): r is WorkoutRecord => r.type === "workout"),
      this.config,
    );
    const canonical: HealthRecord[] = [
      ...steps.samples,
      ...sleep.sessions,
      ...workouts.workouts,
    ];

    // 4. Per-platform diff — GAP FILLING.
    //
    // We never delete or modify a platform's own native records, so writing a
    // canonical record into time the platform already covers natively would
    // re-create the very double counting we just removed (e.g. pushing
    // Apple-Watch-won minutes to Google while Google keeps its native Fitbit
    // samples for those minutes). Instead, each platform receives only the
    // canonical activity that falls into gaps in its own native coverage.
    // Everything we write is tagged so future runs recognize it.
    const plans: PlatformPlan[] = [];
    for (const { provider } of reads) {
      const platform = provider.platform;
      const authored = authoredByPlatform.get(platform)!;
      const platformNative = nativeByPlatform.get(platform)!;
      const wantedExternalIds = new Set<string>();
      const writes: HealthRecord[] = [];

      const candidates: HealthRecord[] = [
        ...fillStepGaps(
          steps.samples,
          platformNative.filter((r): r is StepsSample => r.type === "steps"),
        ),
        ...sleep.sessions.filter(
          (s) =>
            !platformNative.some((n) => n.type === "sleep" && overlaps(n, s)),
        ),
        ...workouts.workouts.filter(
          (w) =>
            !platformNative.some(
              (n) =>
                n.type === "workout" &&
                isDuplicateWorkout(n, w, this.config.workoutOverlapThreshold),
            ),
        ),
      ];

      for (const record of candidates) {
        if (record.source.platform === platform) continue; // already native there
        const fp = fingerprint(record);
        const externalId = `${SYNC_ORIGIN_PREFIX}${fp}`;
        wantedExternalIds.add(externalId);
        const alreadyThere =
          authored.has(externalId) || this.ledger.hasWritten(fp, platform);
        if (!alreadyThere) {
          writes.push({ ...record, nativeId: undefined, externalId });
        }
      }

      // Sync-authored records on this platform that are no longer wanted are
      // stale — e.g. native data arrived late and now covers those minutes,
      // or dedup resolved them to a different device. Remove them so totals
      // stay correct.
      const deletes = [...authored].filter((id) => !wantedExternalIds.has(id));

      plans.push({ platform, writes, deletes });
    }

    // 5. Apply.
    if (!this.dryRun) {
      for (const { provider } of reads) {
        const plan = plans.find((p) => p.platform === provider.platform)!;
        if (plan.deletes.length > 0) {
          await provider.deleteByExternalIds(plan.deletes);
        }
        if (plan.writes.length > 0) {
          await provider.write(plan.writes);
        }
        for (const w of plan.writes) {
          const fp = w.externalId!.slice(SYNC_ORIGIN_PREFIX.length);
          this.ledger.markWritten(fp, provider.platform);
        }
        this.ledger.setLastSyncedThrough(provider.platform, range.end);
      }
      await this.ledger.save();
    }

    return {
      range,
      canonical: {
        steps: steps.samples.length,
        sleepSessions: sleep.sessions.length,
        workouts: workouts.workouts.length,
      },
      stepsDoubleCountRemoved: steps.rawTotal - steps.total,
      sleepDoubleCountRemovedMs: sleep.droppedMs,
      plans,
    };
  }
}
