import { describe, it, expect } from "vitest";
import {
  classifyTakeoutFile,
  parseCumulativeFile,
  parseHeartRateFile,
  parseSleepFile,
  parseStepsFile,
  parseTakeoutFile,
  parseTakeoutTime,
} from "./parse.ts";

const H = 3_600_000;
const M = 60_000;
const OFFSET = -4 * H; // EDT

describe("parseTakeoutTime", () => {
  it("parses Fitbit's MM/dd/yy local format", () => {
    // 07/17/26 08:00:00 local (UTC-4) == 12:00 UTC
    expect(parseTakeoutTime("07/17/26 08:00:00", OFFSET)).toBe(
      Date.UTC(2026, 6, 17, 12, 0, 0),
    );
  });

  it("parses ISO-like local sleep timestamps", () => {
    expect(parseTakeoutTime("2026-07-16T23:00:00.000", OFFSET)).toBe(
      Date.UTC(2026, 6, 17, 3, 0, 0),
    );
  });

  it("returns null for junk", () => {
    expect(parseTakeoutTime("not a date", OFFSET)).toBeNull();
  });
});

describe("parseStepsFile", () => {
  it("coalesces consecutive minutes and skips zeros", () => {
    const samples = parseStepsFile(
      [
        { dateTime: "07/17/26 08:00:00", value: "60" },
        { dateTime: "07/17/26 08:01:00", value: "80" },
        { dateTime: "07/17/26 08:02:00", value: "0" },
        { dateTime: "07/17/26 08:05:00", value: "50" },
      ],
      OFFSET,
    );
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      start: Date.UTC(2026, 6, 17, 12, 0, 0),
      end: Date.UTC(2026, 6, 17, 12, 2, 0),
      steps: 140,
    });
    expect(samples[1]!.steps).toBe(50);
    expect(samples[0]!.source.platform).toBe("google");
  });

  it("tolerates numeric values and bad rows", () => {
    const samples = parseStepsFile(
      [
        { dateTime: "07/17/26 08:00:00", value: 25 },
        { dateTime: "bogus", value: "10" },
        { value: "10" },
      ] as any,
      OFFSET,
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]!.steps).toBe(25);
  });
});

describe("parseCumulativeFile", () => {
  it("scales Takeout distance from centimetres to metres", () => {
    const samples = parseCumulativeFile(
      [{ dateTime: "07/17/26 08:00:00", value: "12000" }],
      OFFSET,
      "distance_m",
      0.01,
    );
    expect(samples[0]).toMatchObject({ metric: "distance_m", value: 120 });
  });
});

describe("parseHeartRateFile", () => {
  it("reads the nested bpm value", () => {
    const points = parseHeartRateFile(
      [
        { dateTime: "07/17/26 08:00:00", value: { bpm: 62, confidence: 2 } },
        { dateTime: "07/17/26 08:01:00", value: { bpm: 0 } },
      ] as any,
      OFFSET,
    );
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      metric: "heart_rate_bpm",
      value: 62,
      start: Date.UTC(2026, 6, 17, 12, 0, 0),
    });
    // Instantaneous.
    expect(points[0]!.end).toBe(points[0]!.start);
  });
});

describe("parseSleepFile", () => {
  it("builds a session with mapped stages", () => {
    const sessions = parseSleepFile(
      [
        {
          logId: 42,
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
    expect(s.start).toBe(Date.UTC(2026, 6, 17, 3, 0, 0));
    expect(s.end).toBe(Date.UTC(2026, 6, 17, 11, 0, 0));
    expect(s.stages.map((x) => x.stage)).toEqual(["light", "deep", "awake"]);
    expect(s.nativeId).toBe("42");
  });

  it("falls back to one asleep block when stages are missing", () => {
    const sessions = parseSleepFile(
      [{ startTime: "2026-07-16T23:00:00.000", endTime: "2026-07-17T07:00:00.000" }],
      OFFSET,
    );
    expect(sessions[0]!.stages).toEqual([
      { stage: "asleep", start: sessions[0]!.start, end: sessions[0]!.end },
    ]);
  });

  it("drops logs with impossible ranges", () => {
    expect(
      parseSleepFile(
        [{ startTime: "2026-07-17T07:00:00.000", endTime: "2026-07-16T23:00:00.000" }],
        OFFSET,
      ),
    ).toHaveLength(0);
  });
});

describe("classifyTakeoutFile / parseTakeoutFile", () => {
  it("recognizes the Global Export Data filenames", () => {
    expect(classifyTakeoutFile("Takeout/Fitbit/Global Export Data/steps-2026-07-17.json")).toEqual({
      kind: "steps",
    });
    expect(
      classifyTakeoutFile("Takeout/Fitbit/Global Export Data/heart_rate-2026-07-17.json"),
    ).toEqual({ kind: "heart_rate" });
    expect(classifyTakeoutFile("Takeout/Fitbit/Global Export Data/sleep-2026-07-17.json")).toEqual({
      kind: "sleep",
    });
    expect(classifyTakeoutFile("Takeout/Fitbit/Profile/profile.csv")).toBeNull();
    expect(classifyTakeoutFile("Takeout/Fitbit/Other/badge-2026.json")).toBeNull();
  });

  it("routes a file to the right parser", () => {
    const records = parseTakeoutFile(
      "Global Export Data/steps-2026-07-17.json",
      [{ dateTime: "07/17/26 08:00:00", value: "100" }],
      OFFSET,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.type).toBe("steps");
  });

  it("returns nothing for unrecognized or non-array content", () => {
    expect(parseTakeoutFile("Global Export Data/steps-2026-07-17.json", {}, OFFSET)).toEqual([]);
    expect(parseTakeoutFile("Other/whatever.json", [], OFFSET)).toEqual([]);
  });
});

describe("classifier tolerance to renames", () => {
  it("accepts -, _ and space separators", () => {
    expect(classifyTakeoutFile("steps-2026-07-17.json")).toEqual({ kind: "steps" });
    expect(classifyTakeoutFile("steps_2026_07.json")).toEqual({ kind: "steps" });
    expect(classifyTakeoutFile("Google Health/heart_rate-2026-07.json")).toEqual({
      kind: "heart_rate",
    });
  });

  it("does not mistake neighbouring files for time series", () => {
    expect(classifyTakeoutFile("sleep_score-2026-07-17.json")).toBeNull();
    expect(classifyTakeoutFile("steps_goal-2026-07-17.json")).toBeNull();
    expect(classifyTakeoutFile("resting_heart_rate-2026-07.json")).toBeNull();
  });
});

describe("dense-series handling", () => {
  const MIN = 60_000;

  it("caps coalesced runs at an hour so a dense series can't collapse", () => {
    // Three hours of never-zero minutes, like Fitbit's BMR calorie series.
    const entries = Array.from({ length: 180 }, (_, i) => {
      const h = 8 + Math.floor(i / 60);
      const m = i % 60;
      return {
        dateTime: `07/17/26 ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`,
        value: "100",
      };
    });
    const samples = parseCumulativeFile(entries, OFFSET, "distance_m", 1);
    expect(samples).toHaveLength(3); // one per hour, not one 3-hour blob
    for (const s of samples) {
      expect(s.end - s.start).toBeLessThanOrEqual(60 * MIN);
    }
    // Total is preserved.
    expect(samples.reduce((t, s) => t + s.value, 0)).toBe(18000);
  });

  it("downsamples heart rate to one averaged sample per minute", () => {
    const entries = [
      { dateTime: "07/17/26 08:00:00", value: { bpm: 60 } },
      { dateTime: "07/17/26 08:00:03", value: { bpm: 62 } },
      { dateTime: "07/17/26 08:00:06", value: { bpm: 64 } },
      { dateTime: "07/17/26 08:01:00", value: { bpm: 70 } },
    ];
    const points = parseHeartRateFile(entries as any, OFFSET);
    expect(points).toHaveLength(2);
    expect(points[0]!.value).toBe(62); // mean of 60/62/64
    expect(points[1]!.value).toBe(70);
    expect(points[1]!.start - points[0]!.start).toBe(MIN);
  });

  it("does not import Fitbit's BMR-inclusive calorie series", () => {
    expect(classifyTakeoutFile("calories-2026-07-17.json")).toBeNull();
    expect(
      parseTakeoutFile(
        "Global Export Data/calories-2026-07-17.json",
        [{ dateTime: "07/17/26 08:00:00", value: "1.2" }],
        OFFSET,
      ),
    ).toEqual([]);
  });
});
