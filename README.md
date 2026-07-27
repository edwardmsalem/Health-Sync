# Health Sync

Two-way smart sync between **Apple Health** and **Google Health** (Health
Connect / Fitbit) that understands **overlapping activity from multiple
devices**.

This is a monorepo:

| Package | What it is |
|---|---|
| [`packages/engine`](packages/engine) | The platform-agnostic sync + dedup engine (this README) — 39 tests |
| [`apps/mobile`](apps/mobile) | The iOS app: HealthKit ⇄ Fitbit cloud, built on the engine — 22 tests, [setup guide](apps/mobile/README.md) |
| [`apps/cadence`](apps/cadence) | Unrelated to the above: a SwiftUI calendar for iOS + macOS merging iCloud/Gmail calendars with Todoist — [setup guide](apps/cadence/README.md) |

If you wear an Apple Watch and a Fitbit at the same time, both record the same
walk and the same night's sleep. Naively merging the two platforms sums them
and doubles your numbers. This engine builds one canonical timeline, removes
the double counting, and syncs only what each platform is actually missing.

```
$ npm run demo

Naive merge (sum both platforms): 17600 steps  <-- double counted!
Double counting removed:          8250 steps
Duplicate sleep removed:          7.75 h

apple:  wrote 2 record(s)   (+ Fitbit's midday steps, + Fitbit's sleep tail)
google: wrote 1 record(s)   (+ Apple Watch's evening steps)

Second sync run writes: 0 (idempotent, no echo)
```

## How the smart dedup works

### Steps — minute-level source arbitration

Step samples from every device on both platforms are sliced onto a
**minute-resolution timeline** (steps allocated proportionally when a sample
spans partial minutes). For each minute:

- Samples from the **same** device are summed (that's just bucketing).
- Samples from **different** devices are competing measurements of the same
  real-world minute — exactly **one device wins the minute**:
  - `stepsStrategy: "priority"` — the device highest in your
    `devicePriority` list wins (e.g. trust the Watch over the phone);
  - `stepsStrategy: "max"` — the device that saw the most steps wins.

Winning minutes are re-aggregated into contiguous samples. Partial overlap
falls out naturally: Watch worn 8:00–9:00 and Fitbit worn 8:30–9:30 yields
Watch-only, contested (one winner), and Fitbit-only segments — never a sum.

### Sleep — session clustering

Overlapping sleep sessions are clustered into "the same night". The cluster's
**primary** session (device priority → richer stage data → longer duration) is
kept whole. Other devices contribute only the pieces the primary missed — e.g.
the Fitbit noticing you fell asleep 20 minutes before the Watch did — and
slivers under `minSleepFragmentMs` (default 15 min) are discarded as noise.
Stage intervals are clipped to the kept fragments. Separate nights and
afternoon naps are never merged.

### Workouts — overlap suppression

Two records of the same activity whose intervals overlap by more than
`workoutOverlapThreshold` of the shorter one are the same workout; the
higher-priority device's record is kept.

### Everything else

Steps and sleep are just the flagship cases — every metric class both
platforms can represent is covered by one of three dedup engines:

| Class | Metrics | Dedup |
|---|---|---|
| **Cumulative** (`CumulativeSample`) | distance, active/basal energy, floors climbed, elevation gained, exercise minutes, hydration, dietary energy, + any custom metric | Same minute-level source arbitration as steps, run independently per metric |
| **Sessions** | sleep (with stages), workouts, and by extension mindfulness-style sessions | Interval clustering / overlap suppression |
| **Point-in-time** (`PointSample`) | heart rate, resting HR, HRV, blood oxygen, respiratory rate, VO₂max, body temperature, weight, body fat, height, blood glucose, blood pressure, + any custom metric | A lower-priority device's reading is dropped when a better device has a reading of the same metric within `pointToleranceMs` (default 5 min); a device is never deduped against its own series |

Metric names are open strings (with typed suggestions), so a bridge can pass
through anything its platform supports without touching the engine.

## How the two-way sync stays safe

Every sync run:

1. **Reads** the window from both platforms.
2. **Separates** native device data from records this engine wrote earlier —
   our writes are tagged `health-sync:<fingerprint>` in the platform's
   external-id field (`HKMetadataKeySyncIdentifier` on HealthKit,
   `clientRecordId` on Health Connect). Only native data feeds the canonical
   timeline, which is what makes echo loops (A→B→A) impossible.
3. **Builds the canonical timeline** from the union of native data using the
   dedup rules above.
4. **Gap-fills each platform**: a platform only receives canonical activity
   that falls into gaps in its *own* native coverage. Your native Fitbit data
   on Google is never fought with — we just don't add a second copy of a
   morning the Fitbit already measured. Stale sync-authored records (e.g. a
   copy made redundant because the device's own data synced in late) are
   deleted.
5. A **ledger** records fingerprints already written, so re-runs are
   idempotent even before reads reflect recent writes.

Native device records are **never modified or deleted** — only records this
engine authored are ever touched.

## Will both platforms show identical data?

They converge on the **same activity timeline**: every walk, night, workout,
and reading exists on both sides. Two honest caveats:

1. **Contested overlap keeps its native measurement.** When both devices
   measured the same minutes (Watch said 4,200 steps for the morning walk,
   Fitbit said 4,350), each platform keeps its own device's number — this
   engine never deletes or overwrites native device data, so those small
   measurement disagreements survive on their home platform. Daily totals can
   therefore differ by the devices' disagreement on co-worn periods only.
2. **A platform can only store what it supports.** Data types with no
   equivalent on the other side (e.g. Apple-only ECG waveforms) stay where
   they were recorded; the bridges sync the (large) intersection.

## Usage

```ts
import {
  SyncEngine,
  AppleHealthProvider,
  GoogleHealthProvider,
  FileLedger,
} from "health-sync";

const engine = new SyncEngine(
  [new AppleHealthProvider(healthKitBridge), new GoogleHealthProvider(healthConnectBridge)],
  {
    dedup: {
      // Most-trusted first. Wearables should outrank phones.
      devicePriority: ["apple-watch", "fitbit-air", "iphone", "pixel"],
      stepsStrategy: "priority",
    },
    ledger: await FileLedger.load(".health-sync/ledger.json"),
  },
);

const report = await engine.sync({
  start: Date.now() - 7 * 24 * 3600_000,
  end: Date.now(),
});
console.log(report.stepsDoubleCountRemoved, "double-counted steps removed");
```

Use `dryRun: true` to preview the plan without writing anything.

## Platform bridges

Neither HealthKit nor Health Connect has a cloud API — both are on-device
stores. The core engine is therefore platform-agnostic and takes injected
bridges:

| Provider | Bridge interface | Backed by |
|---|---|---|
| `AppleHealthProvider` | `HealthKitBridge` | HealthKit in a companion iOS app (Swift / React Native / Capacitor) |
| `GoogleHealthProvider` | `HealthConnectBridge` | Health Connect in an Android app, **or** the Fitbit Web API from a server |
| `MemoryProvider` | — | In-memory store for tests and the demo |

A bridge implements three methods (`read`, `write`, `deleteByExternalIds`) and
must persist each written record's `externalId` — that tag is the linchpin of
echo prevention.

## Development

```
npm install       # workspace root
npm test          # engine (39) + app (22) test suites
npm run demo      # both-devices-worn walkthrough
npm run typecheck
```

## Engine layout

```
packages/engine/src/
  types.ts            normalized data model (steps, sleep, workouts, HR)
  config.ts           device priority + dedup thresholds
  dedup/
    series.ts         generic minute-level arbitration core + gap trimming
    steps.ts          steps (wraps series engine)
    cumulative.ts     distance/calories/floors/... (wraps series engine per metric)
    sleep.ts          session clustering + fragment trimming
    workouts.ts       overlap suppression
    points.ts         heart rate/weight/SpO2/... near-duplicate suppression
  sync/
    engine.ts         two-way sync: canonical timeline, gap-fill, staleness
    fingerprint.ts    content-addressed record identity
    ledger.ts         idempotency ledger (in-memory / JSON file)
  providers/
    provider.ts       platform interface
    apple.ts          HealthKit bridge adapter
    google.ts         Health Connect / Fitbit bridge adapter
    memory.ts         test/demo provider
  demo.ts             runnable walkthrough
```
