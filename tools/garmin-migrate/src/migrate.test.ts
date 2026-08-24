import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkoutRecord } from "health-sync";
import { parseAppleDate, parseExportXml } from "./parseExport.ts";
import { tcxFilename, workoutToTcx } from "./tcx.ts";
import { activityLogsToWorkouts } from "./fitbitActivities.ts";
import { migrate } from "./migrate.ts";

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" value="500" startDate="2026-07-17 08:00:00 -0400" endDate="2026-07-17 08:15:00 -0400" unit="count"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Withings" unit="lb" value="181.5" startDate="2026-07-17 07:30:00 -0400" endDate="2026-07-17 07:30:00 -0400"/>
 <Record type="HKQuantityTypeIdentifierBodyFatPercentage" sourceName="Withings" unit="%" value="0.215" startDate="2026-07-17 07:30:00 -0400" endDate="2026-07-17 07:30:00 -0400"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" sourceName="Edward's Apple Watch" startDate="2026-07-17 07:00:00 -0400" endDate="2026-07-17 07:30:00 -0400">
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5.2" unit="km"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="312" unit="kcal"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="45" durationUnit="min" totalEnergyBurned="200" totalEnergyBurnedUnit="kcal" sourceName="Edward's Apple Watch" startDate="2026-07-16 18:00:00 -0400" endDate="2026-07-16 18:45:00 -0400"/>
</HealthData>`;

describe("parseAppleDate", () => {
  it("parses Apple export timestamps with offsets", () => {
    expect(parseAppleDate("2026-07-17 07:00:00 -0400")).toBe(
      Date.UTC(2026, 6, 17, 11, 0, 0),
    );
    expect(parseAppleDate("2026-01-05 23:30:00 +0100")).toBe(
      Date.UTC(2026, 0, 5, 22, 30, 0),
    );
  });
});

describe("parseExportXml", () => {
  it("extracts workouts (both stat formats) and body metrics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hs-export-"));
    const path = join(dir, "export.xml");
    await writeFile(path, FIXTURE, "utf8");

    const data = await parseExportXml(path);
    expect(data.workouts).toHaveLength(2);
    const run = data.workouts.find((w) => w.activity === "running")!;
    expect(run.distanceMeters).toBe(5200);
    expect(run.activeEnergyKcal).toBe(312);
    expect(run.source.id).toBe("apple-watch");
    const lift = data.workouts.find((w) => w.activity === "strength_training")!;
    expect(lift.activeEnergyKcal).toBe(200);

    expect(data.bodyMetrics).toHaveLength(2);
    const weight = data.bodyMetrics.find((m) => m.metric === "weight_kg")!;
    expect(weight.value).toBeCloseTo(82.33, 1); // 181.5 lb
    const fat = data.bodyMetrics.find((m) => m.metric === "body_fat_pct")!;
    expect(fat.value).toBe(21.5); // stored as 0.215 fraction
  });
});

describe("TCX generation", () => {
  const run: WorkoutRecord = {
    type: "workout",
    activity: "running",
    start: Date.UTC(2026, 6, 17, 11, 0, 0),
    end: Date.UTC(2026, 6, 17, 11, 30, 0),
    source: { id: "apple-watch", name: "Apple Watch", platform: "apple" },
    distanceMeters: 5200,
    activeEnergyKcal: 312,
  };

  it("emits schema-shaped TCX with sport, lap, and trackpoints", () => {
    const xml = workoutToTcx(run);
    expect(xml).toContain('<Activity Sport="Running">');
    expect(xml).toContain("<TotalTimeSeconds>1800</TotalTimeSeconds>");
    expect(xml).toContain("<DistanceMeters>5200</DistanceMeters>");
    expect(xml).toContain("<Calories>312</Calories>");
    expect((xml.match(/<Trackpoint>/g) ?? []).length).toBe(2);
    expect(tcxFilename(run)).toBe("2026-07-17T11-00-00_running.tcx");
  });

  it("maps non-running/cycling to Other", () => {
    const xml = workoutToTcx({ ...run, activity: "strength_training" });
    expect(xml).toContain('<Activity Sport="Other">');
    expect(xml).toContain("strength_training");
  });
});

describe("migrate", () => {
  it("dedupes the same run recorded by watch and Fitbit, writes artifacts", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "hs-garmin-"));
    const appleRun: WorkoutRecord = {
      type: "workout",
      activity: "running",
      start: Date.UTC(2026, 6, 17, 11, 0, 0),
      end: Date.UTC(2026, 6, 17, 11, 30, 0),
      source: { id: "apple-watch", platform: "apple" },
      activeEnergyKcal: 312,
    };
    const fitbitCopies = activityLogsToWorkouts([
      {
        logId: 1,
        activityName: "Run",
        startTime: "2026-07-17T07:01:00.000-04:00",
        duration: 29 * 60_000,
        calories: 305,
      },
      {
        logId: 2,
        activityName: "Outdoor Bike",
        startTime: "2026-07-18T09:00:00.000-04:00",
        duration: 40 * 60_000,
        distance: 15,
      },
    ]);

    const result = await migrate({
      workouts: [appleRun, ...fitbitCopies],
      bodyMetrics: [],
      outDir,
    });

    // The overlapping run collapses to one; the bike ride survives.
    expect(result.tcxFiles).toHaveLength(2);
    expect(result.duplicateWorkoutsDropped).toBe(1);
    const files = await readdir(join(outDir, "tcx"));
    expect(files.some((f) => f.includes("running"))).toBe(true);
    expect(files.some((f) => f.includes("cycling"))).toBe(true);

    const summary = JSON.parse(
      await readFile(join(outDir, "summary.json"), "utf8"),
    );
    expect(summary.workouts).toBe(2);
  });
});
