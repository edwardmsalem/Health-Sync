import { describe, it, expect } from "vitest";
import {
  dayStartMs,
  parseActivityLogs,
  parseIntradayCumulative,
  parseIntradaySteps,
  parseSleepLogs,
  parseWeightLogs,
} from "./parse.ts";
import { serializeRecord, toLocalParts } from "./serialize.ts";
import { FitbitTagStore } from "./tagStore.ts";
import { MemoryKV } from "../storage/kv.ts";

const M = 60_000;
const H = 3_600_000;
// New York in July: UTC-4.
const OFFSET = -4 * H;

describe("intraday parsing", () => {
  it("converts local minute buckets to epoch and merges contiguous runs", () => {
    const samples = parseIntradaySteps(
      "2026-07-17",
      {
        dataset: [
          { time: "08:00:00", value: 60 },
          { time: "08:01:00", value: 80 },
          { time: "08:02:00", value: 0 },
          { time: "08:05:00", value: 50 },
        ],
      },
      OFFSET,
    );
    expect(samples).toHaveLength(2);
    // 08:00 local == 12:00 UTC
    expect(samples[0]!.start).toBe(Date.UTC(2026, 6, 17, 12, 0, 0));
    expect(samples[0]!.end).toBe(Date.UTC(2026, 6, 17, 12, 2, 0));
    expect(samples[0]!.steps).toBe(140);
    expect(samples[1]!.steps).toBe(50);
  });

  it("scales distance km -> m", () => {
    const samples = parseIntradayCumulative(
      "2026-07-17",
      { dataset: [{ time: "08:00:00", value: 0.12 }] },
      OFFSET,
      "distance_m",
      1000,
    );
    expect(samples[0]!.value).toBe(120);
    expect(samples[0]!.metric).toBe("distance_m");
  });
});

describe("sleep parsing", () => {
  it("maps levels to engine stages with correct epochs", () => {
    const sessions = parseSleepLogs(
      [
        {
          logId: 111,
          startTime: "2026-07-16T23:00:00.000",
          endTime: "2026-07-17T07:00:00.000",
          levels: {
            data: [
              { dateTime: "2026-07-16T23:00:00.000", level: "light", seconds: 3600 },
              { dateTime: "2026-07-17T00:00:00.000", level: "deep", seconds: 3600 },
              { dateTime: "2026-07-17T01:00:00.000", level: "wake", seconds: 600 },
            ],
          },
        },
      ],
      OFFSET,
    );
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.start).toBe(Date.UTC(2026, 6, 17, 3, 0, 0)); // 23:00 EDT
    expect(s.stages.map((x) => x.stage)).toEqual(["light", "deep", "awake"]);
    expect(s.logId).toBe(111);
  });
});

describe("activity + weight parsing", () => {
  it("parses activity logs with their embedded offset", () => {
    const workouts = parseActivityLogs([
      {
        logId: 5,
        activityName: "Run",
        startTime: "2026-07-17T07:00:00.000-04:00",
        duration: 30 * M,
        calories: 300,
        distance: 5,
      },
    ]);
    expect(workouts[0]).toMatchObject({
      activity: "running",
      start: Date.UTC(2026, 6, 17, 11, 0, 0),
      distanceMeters: 5000,
    });
  });

  it("emits weight and body fat points", () => {
    const points = parseWeightLogs(
      [{ logId: 9, date: "2026-07-17", time: "07:30:00", weight: 82.4, fat: 21.5 }],
      OFFSET,
    );
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ metric: "weight_kg", value: 82.4 });
    expect(points[1]).toMatchObject({ metric: "body_fat_pct", value: 21.5 });
  });
});

describe("serialization", () => {
  it("formats local date/time from epoch", () => {
    expect(toLocalParts(Date.UTC(2026, 6, 17, 12, 5, 0), OFFSET)).toEqual({
      date: "2026-07-17",
      time: "08:05",
    });
  });

  it("serializes sleep and workouts, refuses raw steps", () => {
    const sleep = serializeRecord(
      {
        type: "sleep",
        source: { id: "apple-watch", platform: "apple" },
        start: Date.UTC(2026, 6, 17, 3, 0, 0),
        end: Date.UTC(2026, 6, 17, 11, 0, 0),
        stages: [],
      },
      OFFSET,
    );
    expect(sleep).toMatchObject({
      kind: "sleep",
      params: { date: "2026-07-16", startTime: "23:00", duration: String(8 * H) },
    });

    const steps = serializeRecord(
      {
        type: "steps",
        steps: 500,
        source: { id: "apple-watch", platform: "apple" },
        start: 0,
        end: M,
      },
      OFFSET,
    );
    expect(steps).toBeNull();
  });
});

describe("FitbitTagStore", () => {
  it("persists logId<->externalId mappings across loads", async () => {
    const kv = new MemoryKV();
    const store = await FitbitTagStore.load(kv);
    store.record(123, "health-sync:abc", "sleep");
    await store.save();

    const reloaded = await FitbitTagStore.load(kv);
    expect(reloaded.externalIdFor(123)).toBe("health-sync:abc");
    expect(reloaded.entryFor("health-sync:abc")).toEqual({ logId: "123", kind: "sleep" });

    reloaded.forget("123");
    expect(reloaded.externalIdFor(123)).toBeUndefined();
  });
});
