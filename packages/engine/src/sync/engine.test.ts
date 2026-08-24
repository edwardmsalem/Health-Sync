import { describe, it, expect } from "vitest";
import { SyncEngine } from "./engine.js";
import { MemoryProvider } from "../providers/memory.js";
import { dedupeSteps } from "../dedup/steps.js";
import { DEFAULT_DEDUP_CONFIG } from "../config.js";
import { isSyncAuthored } from "../types.js";
import type {
  CumulativeSample,
  PointSample,
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

describe("SyncEngine — all metric classes", () => {
  const cumulative = (
    source: SourceRef,
    start: number,
    end: number,
    metric: CumulativeSample["metric"],
    value: number,
  ): CumulativeSample => ({ type: "cumulative", source, start, end, metric, value });

  const point = (
    source: SourceRef,
    at: number,
    metric: PointSample["metric"],
    value: number,
  ): PointSample => ({ type: "point", source, start: at, end: at, metric, value });

  it("syncs heart rate, weight, and distance across platforms without echo", async () => {
    const { apple, google, engine } = make();
    const scale: SourceRef = { id: "withings-scale", platform: "google" };
    // Watch HR during a workout; Fitbit HR overnight; weight only on Google.
    apple.addNative(point(watch, day + 7 * H, "heart_rate_bpm", 142));
    google.addNative(point(fitbit, day + 3 * H, "heart_rate_bpm", 52));
    google.addNative(point(scale, day + 6 * H, "weight_kg", 82.4));
    apple.addNative(cumulative(watch, day + 7 * H, day + 8 * H, "distance_m", 8100));

    const report = await engine.sync(range);
    expect(report.canonical.points).toBe(3);

    // Apple received the overnight HR, the weight, nothing it already had.
    const appleRecords = await apple.read(range);
    const appleWeight = appleRecords.filter(
      (r) => r.type === "point" && r.metric === "weight_kg",
    );
    expect(appleWeight).toHaveLength(1);
    expect(appleWeight[0]).toMatchObject({ value: 82.4 });
    // Google received the workout HR and the distance.
    const googleRecords = await google.read(range);
    expect(
      googleRecords.filter((r) => r.type === "cumulative" && r.metric === "distance_m"),
    ).toHaveLength(1);
    expect(
      googleRecords.filter(
        (r) => r.type === "point" && r.metric === "heart_rate_bpm",
      ),
    ).toHaveLength(2);

    // Idempotent.
    const second = await engine.sync(range);
    for (const plan of second.plans) {
      expect(plan.writes).toHaveLength(0);
      expect(plan.deletes).toHaveLength(0);
    }
  });

  it("does not copy overlapping distance both devices measured", async () => {
    const { apple, google, engine } = make();
    apple.addNative(cumulative(watch, day + 8 * H, day + 9 * H, "distance_m", 3200));
    google.addNative(cumulative(fitbit, day + 8 * H, day + 9 * H, "distance_m", 3350));

    const report = await engine.sync(range);
    expect(report.cumulativeDoubleCountRemoved["distance_m"]).toBeGreaterThan(0);
    for (const plan of report.plans) {
      expect(plan.writes).toHaveLength(0);
    }
  });

  it("does not copy a near-simultaneous HR reading the platform already has", async () => {
    const { apple, google, engine } = make();
    apple.addNative(point(watch, day + 7 * H, "heart_rate_bpm", 142));
    google.addNative(point(fitbit, day + 7 * H + 2 * M, "heart_rate_bpm", 139));

    const report = await engine.sync(range);
    expect(report.pointDuplicatesRemoved).toBe(1);
    for (const plan of report.plans) {
      expect(plan.writes).toHaveLength(0);
    }
  });

  it("cumulative metrics gap-fill independently of steps coverage", async () => {
    const { apple, google, engine } = make();
    // Google has native STEPS for the morning hour but no distance; the
    // watch's distance for that hour must still sync (different metric).
    apple.addNative(cumulative(watch, day + 8 * H, day + 9 * H, "distance_m", 3200));
    google.addNative({
      type: "steps",
      source: fitbit,
      start: day + 8 * H,
      end: day + 9 * H,
      steps: 4000,
    } satisfies StepsSample);

    await engine.sync(range);
    const googleDistance = (await google.read(range)).filter(
      (r) => r.type === "cumulative" && r.metric === "distance_m",
    );
    expect(googleDistance).toHaveLength(1);
  });
});

describe("SyncEngine — three platforms (Apple + Google + Garmin)", () => {
  const garminWatch: SourceRef = { id: "garmin-watch", platform: "garmin" };
  const threeWayOpts = {
    devicePriority: ["apple-watch", "garmin-watch", "fitbit-air"],
    stepsStrategy: "priority" as const,
  };

  function makeThree() {
    const apple = new MemoryProvider("apple");
    const google = new MemoryProvider("google");
    const garmin = new MemoryProvider("garmin");
    const engine = new SyncEngine([apple, google, garmin], {
      dedup: threeWayOpts,
    });
    return { apple, google, garmin, engine };
  }

  it("cross-fills all three platforms from each other's exclusive data", async () => {
    const { apple, google, garmin, engine } = makeThree();
    apple.addNative(steps(watch, day + 8 * H, day + 9 * H, 4200));
    google.addNative(steps(fitbit, day + 12 * H, day + 13 * H, 3100));
    garmin.addNative(steps(garminWatch, day + 18 * H, day + 19 * H, 2000));

    await engine.sync(range);

    // Every platform ends up with all three blocks: 9300 total.
    for (const p of [apple, google, garmin]) {
      const all = (await p.read(range)).filter(
        (r): r is StepsSample => r.type === "steps",
      );
      expect(all.reduce((s, r) => s + r.steps, 0)).toBe(9300);
      // Two of the three blocks are synced copies, one is native.
      expect(all.filter((r) => isSyncAuthored(r))).toHaveLength(2);
    }
  });

  it("resolves a three-device overlap to one winner everywhere", async () => {
    const { apple, google, garmin, engine } = makeThree();
    // All three devices worn for the same morning walk.
    apple.addNative(steps(watch, day + 8 * H, day + 9 * H, 4200));
    google.addNative(steps(fitbit, day + 8 * H, day + 9 * H, 4350));
    garmin.addNative(steps(garminWatch, day + 8 * H, day + 9 * H, 4100));

    const report = await engine.sync(range);

    // 12650 raw -> 4200 canonical (watch is top priority).
    expect(report.stepsDoubleCountRemoved).toBe(8450);
    // Everyone already covers that hour natively: nothing to write.
    for (const plan of report.plans) {
      expect(plan.writes).toHaveLength(0);
    }
  });

  it("three-way sleep: one night tracked by all three stays one night", async () => {
    const { apple, google, garmin, engine } = makeThree();
    apple.addNative(sleep(watch, day - H + 10 * M, day + 6 * H + 45 * M));
    google.addNative(sleep(fitbit, day - H, day + 6 * H + 55 * M));
    garmin.addNative(sleep(garminWatch, day - H + 5 * M, day + 6 * H + 50 * M));

    await engine.sync(range);

    // No platform received a duplicate night (each already overlaps it).
    for (const p of [apple, google, garmin]) {
      const sessions = (await p.read(range)).filter((r) => r.type === "sleep");
      expect(sessions).toHaveLength(1);
    }
  });

  it("second three-way run is a no-op", async () => {
    const { apple, google, garmin, engine } = makeThree();
    apple.addNative(steps(watch, day + 8 * H, day + 9 * H, 4200));
    google.addNative(sleep(fitbit, day - H, day + 7 * H));
    garmin.addNative(steps(garminWatch, day + 18 * H, day + 19 * H, 2000));

    await engine.sync(range);
    const second = await engine.sync(range);
    for (const plan of second.plans) {
      expect(plan.writes).toHaveLength(0);
      expect(plan.deletes).toHaveLength(0);
    }
  });
});

describe("SyncEngine — read-only source providers (Nightscout)", () => {
  const aaps: SourceRef = { id: "aaps", platform: "nightscout" };

  it("read-only data reaches every writable platform, source is never written", async () => {
    const apple = new MemoryProvider("apple");
    const google = new MemoryProvider("google");
    const nightscout = new MemoryProvider("nightscout", [], true);
    const glucose = (at: number, mgdl: number): PointSample => ({
      type: "point",
      metric: "blood_glucose_mgdl",
      value: mgdl,
      start: at,
      end: at,
      source: aaps,
    });
    nightscout.addNative(glucose(day + 8 * H, 110), glucose(day + 8 * H + 5 * M, 122));

    const engine = new SyncEngine([apple, google, nightscout], { dedup: dedupOpts });
    const report = await engine.sync(range);

    // Glucose landed on Apple (and Google), tagged as synced.
    const appleGlucose = (await apple.read(range)).filter(
      (r) => r.type === "point" && r.metric === "blood_glucose_mgdl",
    );
    expect(appleGlucose).toHaveLength(2);
    expect(appleGlucose.every((r) => isSyncAuthored(r))).toBe(true);

    // Nothing was ever planned for the read-only source.
    const nsPlan = report.plans.find((p) => p.platform === "nightscout")!;
    expect(nsPlan.writes).toHaveLength(0);
    expect(nsPlan.deletes).toHaveLength(0);
    expect(await nightscout.read(range)).toHaveLength(2); // untouched

    // Idempotent.
    const second = await engine.sync(range);
    for (const plan of second.plans) expect(plan.writes).toHaveLength(0);
  });

  it("nearby readings native on a platform suppress the read-only copy", async () => {
    const apple = new MemoryProvider("apple");
    const google = new MemoryProvider("google");
    const nightscout = new MemoryProvider("nightscout", [], true);
    // Apple already has a glucose reading (e.g. manual meter entry) 2 min away.
    apple.addNative({
      type: "point",
      metric: "blood_glucose_mgdl",
      value: 112,
      start: day + 8 * H + 2 * M,
      end: day + 8 * H + 2 * M,
      source: watch,
    });
    nightscout.addNative({
      type: "point",
      metric: "blood_glucose_mgdl",
      value: 110,
      start: day + 8 * H,
      end: day + 8 * H,
      source: aaps,
    });

    const engine = new SyncEngine([apple, google, nightscout], { dedup: dedupOpts });
    await engine.sync(range);
    const appleGlucose = (await apple.read(range)).filter(
      (r) => r.type === "point" && r.metric === "blood_glucose_mgdl",
    );
    expect(appleGlucose).toHaveLength(1); // no near-duplicate added
  });
});
