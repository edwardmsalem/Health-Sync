import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { MemoryProvider, SyncEngine, isSyncAuthored, type StepsSample } from "health-sync";
import { TakeoutProvider } from "./provider.ts";
import { parseTakeoutZip } from "./zip.ts";

const H = 3_600_000;
const OFFSET = -4 * H;
const day = Date.UTC(2026, 6, 17);

describe("TakeoutProvider", () => {
  const steps = (start: number, end: number, n: number): StepsSample => ({
    type: "steps",
    source: { id: "fitbit", platform: "google" },
    start,
    end,
    steps: n,
  });

  it("is read-only and filters by range", async () => {
    const p = new TakeoutProvider([
      steps(day + 8 * H, day + 9 * H, 100),
      steps(day + 30 * H, day + 31 * H, 200),
    ]);
    expect(p.readOnly).toBe(true);
    const inRange = await p.read({ start: day, end: day + 24 * H });
    expect(inRange).toHaveLength(1);
    await expect(p.write()).rejects.toThrow(/read-only/);
  });

  it("reports the covered span", () => {
    const p = new TakeoutProvider([
      steps(day + 8 * H, day + 9 * H, 100),
      steps(day + 30 * H, day + 31 * H, 200),
    ]);
    expect(p.span()).toEqual({ start: day + 8 * H, end: day + 31 * H + 1 });
    expect(new TakeoutProvider([]).span()).toBeNull();
  });

  it("merges into Apple Health through the engine without double counting", async () => {
    const apple = new MemoryProvider("apple");
    // Apple already has the Watch's version of the 08:00 hour.
    apple.addNative({
      type: "steps",
      source: { id: "apple-watch", platform: "apple" },
      start: day + 8 * H,
      end: day + 9 * H,
      steps: 4200,
    });
    const takeout = new TakeoutProvider([
      steps(day + 8 * H, day + 9 * H, 4350), // overlapping — must not be copied
      steps(day + 12 * H, day + 13 * H, 3100), // Fitbit-only — must be imported
    ]);

    const engine = new SyncEngine([apple, takeout], {
      dedup: { devicePriority: ["apple-watch", "fitbit"], stepsStrategy: "priority" },
    });
    const report = await engine.sync({ start: day, end: day + 24 * H });

    const appleSteps = (await apple.read({ start: day, end: day + 24 * H })).filter(
      (r): r is StepsSample => r.type === "steps",
    );
    expect(appleSteps).toHaveLength(2);
    const imported = appleSteps.filter((r) => isSyncAuthored(r));
    expect(imported).toHaveLength(1);
    expect(imported[0]!.steps).toBe(3100);
    expect(report.stepsDoubleCountRemoved).toBeGreaterThan(0);

    // Nothing was written back to the read-only source.
    expect(report.plans.find((p) => p.platform === "google")!.writes).toHaveLength(0);
  });
});

describe("parseTakeoutZip", () => {
  it("reads only recognized Fitbit files out of a zip", () => {
    const zip = zipSync({
      "Takeout/Fitbit/Global Export Data/steps-2026-07-17.json": strToU8(
        JSON.stringify([{ dateTime: "07/17/26 08:00:00", value: "120" }]),
      ),
      "Takeout/Fitbit/Global Export Data/heart_rate-2026-07-17.json": strToU8(
        JSON.stringify([{ dateTime: "07/17/26 08:00:00", value: { bpm: 61 } }]),
      ),
      "Takeout/Fitbit/Profile/profile.csv": strToU8("ignored"),
      "Takeout/Fitbit/Other/badges.json": strToU8(JSON.stringify([{ x: 1 }])),
    });

    const { records, filesParsed } = parseTakeoutZip(zip, OFFSET);

    expect(filesParsed).toBe(2); // csv and unknown json filtered out
    expect(records.filter((r) => r.type === "steps")).toHaveLength(1);
    expect(records.filter((r) => r.type === "point")).toHaveLength(1);
  });

  it("skips a malformed file instead of failing the import", () => {
    const zip = zipSync({
      "Global Export Data/steps-2026-07-17.json": strToU8("{not json"),
      "Global Export Data/steps-2026-07-18.json": strToU8(
        JSON.stringify([{ dateTime: "07/18/26 09:00:00", value: "55" }]),
      ),
    });
    const { records, filesParsed } = parseTakeoutZip(zip, OFFSET);
    expect(filesParsed).toBe(2);
    expect(records).toHaveLength(1);
  });
});
