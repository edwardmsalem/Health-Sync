import { describe, it, expect } from "vitest";
import { SyncEngine } from "./engine.js";
import { MemoryProvider } from "../providers/memory.js";
import { dedupeSteps } from "../dedup/steps.js";
import { DEFAULT_DEDUP_CONFIG } from "../config.js";
import { isSyncAuthored } from "../types.js";
import type {
  SourceRef,
  StepsSample,
  SleepSession,
  TimeRange,
} from "../types.js";

const H = 3_600_000;
const M = 60_000;
const day = Date.UTC(2026, 6, 17);
const range: TimeRange = { start: day - 2 * H, end: day + 24 * H };

const watch: SourceRef = { id: "apple-watch", platform: "apple" };
const fitbit: SourceRef = { id: "fitbit-air", platform: "google" };

const steps = (
  source: SourceRef,
  start: number,
  end: number,
  n: number,
): StepsSample => ({ type: "steps", source, start, end, steps: n });

const sleep = (
  source: SourceRef,
  start: number,
  end: number,
): SleepSession => ({
  type: "sleep",
  source,
  start,
  end,
  stages: [{ stage: "asleep", start, end }],
});

const dedupOpts = {
  devicePriority: ["apple-watch", "fitbit-air"],
  stepsStrategy: "priority" as const,
};

/** A platform's daily step total the way the platform would compute it. */
async function platformTotal(p: MemoryProvider): Promise<number> {
  const all = (await p.read(range)).filter(
    (r): r is StepsSample => r.type === "steps",
  );
  return dedupeSteps(all, { ...DEFAULT_DEDUP_CONFIG, ...dedupOpts }).total;
}

function make() {
  const apple = new MemoryProvider("apple");
  const google = new MemoryProvider("google");
  const engine = new SyncEngine([apple, google], { dedup: dedupOpts });
  return { apple, google, engine };
}

describe("SyncEngine", () => {
  it("copies activity that only exists on one platform to the other", async () => {
    const { apple, google, engine } = make();
    apple.addNative(steps(watch, day + 18 * H, day + 19 * H, 2050));

    await engine.sync(range);

    const googleSteps = (await google.read(range)).filter(
      (r): r is StepsSample => r.type === "steps",
    );
    expect(googleSteps).toHaveLength(1);
    expect(googleSteps[0]!.steps).toBe(2050);
    expect(isSyncAuthored(googleSteps[0]!)).toBe(true);
  });

  it("does NOT copy overlapping steps into a platform that already covers them", async () => {
    const { apple, google, engine } = make();
    // Both wrists worn on the same morning walk.
    apple.addNative(steps(watch, day + 8 * H, day + 9 * H, 4200));
    google.addNative(steps(fitbit, day + 8 * H, day + 9 * H, 4350));

    const report = await engine.sync(range);

    // The overlap means neither platform needs anything: each already has a
    // native measurement of that hour. Both totals stay sane.
    expect(report.stepsDoubleCountRemoved).toBeGreaterThan(0);
    expect(await platformTotal(apple)).toBe(4200);
    expect(await platformTotal(google)).toBe(4350);
    for (const plan of report.plans) {
      expect(plan.writes).toHaveLength(0);
    }
  });

  it("gap-fills partial overlap without double counting", async () => {
    const { apple, google, engine } = make();
    // Watch 08:00-09:00; Fitbit 08:30-09:30 (half overlapping).
    apple.addNative(steps(watch, day + 8 * H, day + 9 * H, 3000));
    google.addNative(steps(fitbit, day + 8.5 * H, day + 9.5 * H, 3000));

    await engine.sync(range);

    // Apple gets the fitbit-only tail (09:00-09:30 = 1500), not the overlap.
    expect(await platformTotal(apple)).toBe(4500);
    // Google gets the watch-only head (08:00-08:30 = 1500).
    expect(await platformTotal(google)).toBe(4500);
  });

  it("is idempotent: second run writes nothing (no echo loop)", async () => {
    const { apple, google, engine } = make();
    apple.addNative(steps(watch, day + 18 * H, day + 19 * H, 2050));
    apple.addNative(sleep(watch, day - H, day + 7 * H));
    google.addNative(steps(fitbit, day + 12 * H, day + 13 * H, 3100));

    await engine.sync(range);
    const second = await engine.sync(range);

    for (const plan of second.plans) {
      expect(plan.writes).toHaveLength(0);
      expect(plan.deletes).toHaveLength(0);
    }
    // And a third run via a FRESH engine (empty ledger) still writes nothing,
    // because sync-authored records are recognized by their externalId tag.
    const freshEngine = new SyncEngine([apple, google], { dedup: dedupOpts });
    const third = await freshEngine.sync(range);
    for (const plan of third.plans) {
      expect(plan.writes).toHaveLength(0);
    }
  });

  it("syncs sleep one way and skips nights the other platform already tracked", async () => {
    const { apple, google, engine } = make();
    // Same night on both platforms (different devices).
    apple.addNative(sleep(watch, day - H + 10 * M, day + 6 * H + 45 * M));
    google.addNative(sleep(fitbit, day - H, day + 7 * H));
    // A nap only the watch saw.
    apple.addNative(sleep(watch, day + 14 * H, day + 15 * H));

    await engine.sync(range);

    const googleSleep = (await google.read(range)).filter(
      (r) => r.type === "sleep",
    );
    // Native night + synced nap. The overlapping night was NOT copied.
    expect(googleSleep).toHaveLength(2);
    const synced = googleSleep.filter((r) => isSyncAuthored(r));
    expect(synced).toHaveLength(1);
    expect(synced[0]!.start).toBe(day + 14 * H);
  });

  it("removes stale sync-authored records when native data arrives late", async () => {
    const { apple, google, engine } = make();
    apple.addNative(steps(watch, day + 8 * H, day + 9 * H, 3000));

    await engine.sync(range);
    expect(await platformTotal(google)).toBe(3000);

    // Fitbit's own data for that hour arrives late (device synced later).
    google.addNative(steps(fitbit, day + 8 * H, day + 9 * H, 3100));
    const report = await engine.sync(range);

    // The previously synced copy is now redundant on Google — deleted.
    const plan = report.plans.find((p) => p.platform === "google")!;
    expect(plan.deletes).toHaveLength(1);
    const googleSteps = (await google.read(range)).filter(
      (r): r is StepsSample => r.type === "steps",
    );
    expect(googleSteps).toHaveLength(1);
    expect(googleSteps[0]!.source.id).toBe("fitbit-air");
  });

  it("dryRun computes a plan without touching either platform", async () => {
    const { apple, google } = make();
    apple.addNative(steps(watch, day + 8 * H, day + 9 * H, 3000));
    const engine = new SyncEngine([apple, google], {
      dedup: dedupOpts,
      dryRun: true,
    });

    const report = await engine.sync(range);
    const plan = report.plans.find((p) => p.platform === "google")!;
    expect(plan.writes).toHaveLength(1);
    expect(await google.read(range)).toHaveLength(0);
  });

  it("rejects duplicate platforms", () => {
    expect(
      () => new SyncEngine([new MemoryProvider("apple"), new MemoryProvider("apple")]),
    ).toThrow();
  });
});
