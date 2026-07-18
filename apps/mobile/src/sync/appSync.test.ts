/**
 * End-to-end app test: the REAL engine + REAL bridges, with only the device
 * boundaries faked (an in-memory HealthKit store and a fake Fitbit HTTP
 * server). Verifies the whole iOS data path: HealthKit DTOs -> engine ->
 * Fitbit API calls, and back, with echo prevention across runs.
 */

import { describe, it, expect } from "vitest";
import {
  AppleHealthProvider,
  GoogleHealthProvider,
  SyncEngine,
  type TimeRange,
} from "health-sync";
import { AppleHealthKitBridge, type HKClient } from "../healthkit/bridge.ts";
import { HK_EXTERNAL_ID_KEY, SLEEP_TYPE, type HKSampleDTO } from "../healthkit/mapping.ts";
import { FitbitBridge, type FitbitHttp } from "../fitbit/bridge.ts";
import { FitbitTagStore } from "../fitbit/tagStore.ts";
import { MemoryKV } from "../storage/kv.ts";
import { loadLedger } from "./ledgerStore.ts";

const H = 3_600_000;
const M = 60_000;
const day = Date.UTC(2026, 6, 17);
const OFFSET = -4 * H; // EDT

/** In-memory HealthKit. */
class FakeHKClient implements HKClient {
  samples: HKSampleDTO[] = [];

  async requestPermissions(): Promise<void> {}

  async queryQuantitySamples(type: string, range: TimeRange): Promise<HKSampleDTO[]> {
    return this.samples.filter(
      (s) => s.typeIdentifier === type && s.startMs < range.end && s.endMs >= range.start,
    );
  }
  queryCategorySamples = this.queryQuantitySamples.bind(this);

  async queryWorkouts(): Promise<HKSampleDTO[]> {
    return [];
  }

  async save(dto: HKSampleDTO): Promise<void> {
    this.samples.push({ ...dto, uuid: `uuid-${this.samples.length}` });
  }

  async deleteByMetadata(type: string, key: string, values: string[]): Promise<void> {
    this.samples = this.samples.filter(
      (s) =>
        s.typeIdentifier !== type ||
        !values.includes(s.metadata?.[key] as string),
    );
  }
}

/** Fake Fitbit cloud: canned reads, records writes, supports deletes. */
class FakeFitbitHttp implements FitbitHttp {
  sleepLogs: any[] = [];
  activityLogs: any[] = [];
  weightLogs: any[] = [];
  intradaySteps: { time: string; value: number }[] = [];
  posts: { path: string; params: string }[] = [];
  deletes: string[] = [];
  private nextLogId = 1000;

  async request(method: "GET" | "POST" | "DELETE", path: string, body?: URLSearchParams): Promise<unknown> {
    if (method === "GET") {
      if (path.includes("/activities/steps/date/2026-07-17/"))
        return { "activities-steps-intraday": { dataset: this.intradaySteps } };
      if (path.includes("/activities/steps/date/"))
        return { "activities-steps-intraday": { dataset: [] } };
      if (path.includes("/activities/distance/") || path.includes("/activities/calories/"))
        return {};
      if (path.includes("/activities/heart/"))
        return { "activities-heart-intraday": { dataset: [] } };
      if (path.includes("/sleep/date/")) return { sleep: this.sleepLogs };
      if (path.includes("/body/log/weight/date/")) return { weight: this.weightLogs };
      if (path.includes("/activities/list")) return { activities: this.activityLogs };
      throw new Error(`unexpected GET ${path}`);
    }
    if (method === "POST") {
      this.posts.push({ path, params: body?.toString() ?? "" });
      const logId = this.nextLogId++;
      if (path.includes("/sleep")) {
        // Simulate Fitbit materializing the logged sleep.
        const params = Object.fromEntries(new URLSearchParams(body?.toString()));
        const startLocal = `${params.date}T${params.startTime}:00.000`;
        const endMs = Date.parse(`${startLocal}Z`) + Number(params.duration);
        const endLocal = new Date(endMs).toISOString().slice(0, -1);
        this.sleepLogs.push({ logId, startTime: startLocal, endTime: endLocal });
        return { sleep: { logId } };
      }
      if (path.includes("/activities")) return { activityLog: { logId } };
      if (path.includes("/weight")) return { weightLog: { logId } };
      return {};
    }
    this.deletes.push(path);
    return null;
  }
}

async function makeStack() {
  const kv = new MemoryKV();
  const hk = new FakeHKClient();
  const fitbitHttp = new FakeFitbitHttp();
  const makeEngine = async () =>
    new SyncEngine(
      [
        new AppleHealthProvider(new AppleHealthKitBridge(hk)),
        new GoogleHealthProvider(
          new FitbitBridge(fitbitHttp, await FitbitTagStore.load(kv), OFFSET),
        ),
      ],
      {
        dedup: { devicePriority: ["apple-watch", "fitbit"], stepsStrategy: "priority" },
        ledger: await loadLedger(kv),
      },
    );
  return { hk, fitbitHttp, makeEngine };
}

const range: TimeRange = { start: day, end: day + 24 * H };

describe("iOS app end-to-end sync", () => {
  it("pushes watch sleep to Fitbit, pulls Fitbit steps into HealthKit, no echo", async () => {
    const { hk, fitbitHttp, makeEngine } = await makeStack();

    // Watch sleep in HealthKit: 01:00-08:00 UTC (21:00-04:00 local EDT).
    hk.samples.push({
      typeIdentifier: SLEEP_TYPE,
      value: 3,
      startMs: day + 1 * H,
      endMs: day + 8 * H,
      sourceProductType: "Watch7,2",
      sourceName: "Apple Watch",
    });
    // Fitbit-only midday steps (12:00 local == 16:00 UTC).
    fitbitHttp.intradaySteps = [
      { time: "12:00:00", value: 70 },
      { time: "12:01:00", value: 90 },
    ];

    const engine = await makeEngine();
    const report = await engine.sync(range);

    // Sleep was posted to Fitbit.
    expect(fitbitHttp.posts.some((p) => p.path.includes("/sleep"))).toBe(true);
    // Fitbit steps landed in HealthKit, tagged.
    const hkSteps = hk.samples.filter(
      (s) => s.typeIdentifier === "HKQuantityTypeIdentifierStepCount",
    );
    expect(hkSteps).toHaveLength(1);
    expect(hkSteps[0]!.value).toBe(160);
    expect(String(hkSteps[0]!.metadata?.[HK_EXTERNAL_ID_KEY])).toMatch(/^health-sync:/);
    expect(report.plans.find((p) => p.platform === "google")!.writes).toHaveLength(1);

    // Second run with FRESH engine instances (fresh reads of both stores):
    // nothing new is written anywhere.
    const engine2 = await makeEngine();
    const second = await engine2.sync(range);
    for (const plan of second.plans) {
      expect(plan.writes).toHaveLength(0);
      expect(plan.deletes).toHaveLength(0);
    }
    expect(fitbitHttp.posts.filter((p) => p.path.includes("/sleep"))).toHaveLength(1);
  });

  it("does not duplicate a night both devices tracked", async () => {
    const { hk, fitbitHttp, makeEngine } = await makeStack();
    hk.samples.push({
      typeIdentifier: SLEEP_TYPE,
      value: 1,
      startMs: day + 1 * H + 10 * M,
      endMs: day + 8 * H,
      sourceProductType: "Watch7,2",
      sourceName: "Apple Watch",
    });
    fitbitHttp.sleepLogs.push({
      logId: 7,
      startTime: "2026-07-16T21:00:00.000", // 01:00 UTC
      endTime: "2026-07-17T04:05:00.000", // 08:05 UTC
    });

    const engine = await makeEngine();
    await engine.sync(range);
    // No sleep POST to Fitbit (night already there), and HealthKit gained at
    // most a small non-overlapping fragment, not a full duplicate night.
    expect(fitbitHttp.posts.filter((p) => p.path.includes("/sleep"))).toHaveLength(0);
    const hkSleep = hk.samples.filter((s) => s.typeIdentifier === SLEEP_TYPE);
    expect(hkSleep).toHaveLength(1); // just the original watch session
  });

  it("counts un-ingestable records as skipped instead of failing", async () => {
    const { hk, fitbitHttp, makeEngine } = await makeStack();
    // Watch-only steps: Fitbit has no write API for these.
    hk.samples.push({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      value: 2050,
      startMs: day + 18 * H,
      endMs: day + 18 * H + 30 * M,
      sourceProductType: "Watch7,2",
      sourceName: "Apple Watch",
    });

    const engine = await makeEngine();
    const report = await engine.sync(range);
    expect(report.plans.find((p) => p.platform === "google")!.writes.length).toBeGreaterThan(0);
    expect(fitbitHttp.posts).toHaveLength(0); // nothing Fitbit could accept
  });
});
