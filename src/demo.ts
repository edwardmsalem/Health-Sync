/**
 * Demo: a day where you wore BOTH your Apple Watch and your Fitbit.
 *
 *   npm run demo
 *
 * Shows the engine noticing the overlap, removing the double counting, and
 * gap-filling each platform so both end up with the same true totals.
 */

import { SyncEngine } from "./sync/engine.js";
import { MemoryProvider } from "./providers/memory.js";
import { dedupeSteps } from "./dedup/steps.js";
import { DEFAULT_DEDUP_CONFIG } from "./config.js";
import type {
  CumulativeSample,
  PointSample,
  SourceRef,
  StepsSample,
  SleepSession,
} from "./types.js";

const H = 3_600_000;
const M = 60_000;
const day = Date.UTC(2026, 6, 17); // 2026-07-17T00:00Z

const watch: SourceRef = { id: "apple-watch", name: "Apple Watch", platform: "apple" };
const fitbit: SourceRef = { id: "fitbit-air", name: "Fitbit Air", platform: "google" };
const iphone: SourceRef = { id: "iphone", name: "iPhone", platform: "apple" };

const steps = (source: SourceRef, start: number, end: number, n: number): StepsSample => ({
  type: "steps", source, start, end, steps: n,
});

const apple = new MemoryProvider("apple");
const google = new MemoryProvider("google");

// Morning walk 08:00-09:00 — BOTH wrists busy. Watch says 4200, Fitbit 4350.
apple.addNative(steps(watch, day + 8 * H, day + 9 * H, 4200));
google.addNative(steps(fitbit, day + 8 * H, day + 9 * H, 4350));

// Midday: only the Fitbit was worn (watch charging), 12:00-13:00.
google.addNative(steps(fitbit, day + 12 * H, day + 13 * H, 3100));

// Evening: only the Apple Watch, 18:00-18:30.
apple.addNative(steps(watch, day + 18 * H, day + 18.5 * H, 2050));

// Phone counted a few pocket steps during the morning walk too (a third
// overlapping source on the SAME platform).
apple.addNative(steps(iphone, day + 8 * H, day + 9 * H, 3900));

// Last night's sleep, tracked by both devices.
const sleepApple: SleepSession = {
  type: "sleep", source: watch,
  start: day - 1 * H + 10 * M,        // 23:10
  end: day + 6 * H + 45 * M,          // 06:45
  stages: [
    { stage: "light", start: day - 1 * H + 10 * M, end: day + 2 * H },
    { stage: "deep", start: day + 2 * H, end: day + 3 * H },
    { stage: "rem", start: day + 3 * H, end: day + 4 * H },
    { stage: "light", start: day + 4 * H, end: day + 6 * H + 45 * M },
  ],
};
const sleepGoogle: SleepSession = {
  type: "sleep", source: fitbit,
  start: day - 1 * H,                 // 23:00 — Fitbit noticed sleep earlier
  end: day + 7 * H + 5 * M,           // 07:05 — and later
  stages: [{ stage: "asleep", start: day - 1 * H, end: day + 7 * H + 5 * M }],
};
apple.addNative(sleepApple);
google.addNative(sleepGoogle);

// Both devices also measured DISTANCE for the morning walk — same overlap
// problem as steps, same fix.
const dist = (source: SourceRef, start: number, end: number, m: number): CumulativeSample => ({
  type: "cumulative", metric: "distance_m", source, start, end, value: m,
});
apple.addNative(dist(watch, day + 8 * H, day + 9 * H, 3200));
google.addNative(dist(fitbit, day + 8 * H, day + 9 * H, 3350));

// Heart rate: watch during the evening walk, fitbit overnight; and a smart
// scale weigh-in that only Google knows about.
const point = (source: SourceRef, at: number, metric: PointSample["metric"], v: number): PointSample => ({
  type: "point", source, start: at, end: at, metric, value: v,
});
apple.addNative(point(watch, day + 18 * H + 10 * M, "heart_rate_bpm", 118));
google.addNative(point(fitbit, day + 3 * H, "heart_rate_bpm", 52));
google.addNative(point({ id: "withings-scale", name: "Bathroom scale", platform: "google" }, day + 7 * H + 30 * M, "weight_kg", 82.4));

const range = { start: day - 2 * H, end: day + 24 * H };

const rawApple = (await apple.read(range)).filter((r) => r.type === "steps");
const rawGoogle = (await google.read(range)).filter((r) => r.type === "steps");
const naiveTotal = [...rawApple, ...rawGoogle].reduce(
  (s, r) => s + (r.type === "steps" ? r.steps : 0), 0,
);

const engine = new SyncEngine([apple, google], {
  dedup: {
    devicePriority: ["apple-watch", "fitbit-air", "iphone"],
    stepsStrategy: "priority",
  },
});

const report = await engine.sync(range);

console.log("=== Health Sync demo: Apple Watch + Fitbit worn together ===\n");
console.log(`Naive merge (sum both platforms): ${naiveTotal} steps  <-- double counted!`);
console.log(`Double counting removed:          ${report.stepsDoubleCountRemoved} steps`);
console.log(
  `Duplicate sleep removed:          ${(report.sleepDoubleCountRemovedMs / H).toFixed(2)} h\n`,
);

for (const plan of report.plans) {
  console.log(`${plan.platform}: wrote ${plan.writes.length} record(s), deleted ${plan.deletes.length}`);
  for (const w of plan.writes) {
    const when = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    if (w.type === "steps") {
      console.log(`  + steps ${w.steps} @ ${when(w.start)}-${when(w.end)} (from ${w.source.name})`);
    } else if (w.type === "sleep") {
      console.log(`  + sleep ${when(w.start)}-${when(w.end)} (from ${w.source.name})`);
    } else if (w.type === "cumulative") {
      console.log(`  + ${w.metric} ${w.value} @ ${when(w.start)}-${when(w.end)} (from ${w.source.name})`);
    } else if (w.type === "point") {
      console.log(`  + ${w.metric} ${w.value} @ ${when(w.start)} (from ${w.source.name})`);
    }
  }
}

// After sync, each platform's canonical view (running its data through the
// same dedup) agrees on the day's true totals.
for (const [name, provider] of [["apple", apple], ["google", google]] as const) {
  const all = (await provider.read(range)).filter(
    (r): r is StepsSample => r.type === "steps",
  );
  const view = dedupeSteps(all, {
    ...DEFAULT_DEDUP_CONFIG,
    devicePriority: ["apple-watch", "fitbit-air", "iphone"],
    stepsStrategy: "priority",
  });
  console.log(`\n${name} platform daily steps after sync: ${view.total}`);
}

const second = await engine.sync(range);
const secondWrites = second.plans.reduce((s, p) => s + p.writes.length, 0);
console.log(`\nSecond sync run writes: ${secondWrites} (idempotent, no echo)`);
