/**
 * Write-read-count proof for insulin, against a HealthKit stand-in that
 * enforces Apple's real rules: a sample carrying HKMetadataKeySyncIdentifier
 * is only stored if no sample with that identifier exists, or the incoming
 * HKMetadataKeySyncVersion is HIGHER. Anything else is a no-op, not a second
 * row. Without a sync identifier, every save appends — which is what produced
 * duplicate rows in Health.
 */

import { describe, it, expect } from "vitest";
import {
  AppleHealthProvider,
  SyncEngine,
  type HealthRecord,
  type PointSample,
  type CumulativeSample,
} from "health-sync";
import { AppleHealthKitBridge, type HKClient } from "./bridge.ts";
import {
  HK_SYNC_IDENTIFIER_KEY,
  HK_SYNC_VERSION_KEY,
  type HKSampleDTO,
} from "./mapping.ts";
import { MemoryProvider } from "health-sync";

const H = 3_600_000;
const M = 60_000;
const day = Date.UTC(2026, 7, 25);
const INSULIN = "HKQuantityTypeIdentifierInsulinDelivery";

class FakeHK implements HKClient {
  samples: HKSampleDTO[] = [];
  private n = 0;

  async requestPermissions(): Promise<void> {}

  async queryQuantitySamples(type: string): Promise<HKSampleDTO[]> {
    return this.samples.filter((s) => s.typeIdentifier === type);
  }
  async queryCategorySamples(): Promise<HKSampleDTO[]> {
    return [];
  }
  async queryWorkouts(): Promise<HKSampleDTO[]> {
    return [];
  }

  async save(dto: HKSampleDTO): Promise<void> {
    const id = dto.metadata?.[HK_SYNC_IDENTIFIER_KEY] as string | undefined;
    if (id) {
      const existing = this.samples.find(
        (s) => s.metadata?.[HK_SYNC_IDENTIFIER_KEY] === id,
      );
      if (existing) {
        const incoming = Number(dto.metadata?.[HK_SYNC_VERSION_KEY] ?? 0);
        const current = Number(existing.metadata?.[HK_SYNC_VERSION_KEY] ?? 0);
        if (incoming <= current) return; // Apple ignores it — no duplicate row
        Object.assign(existing, dto);
        return;
      }
    }
    this.samples.push({ ...dto, uuid: `u${this.n++}` });
  }

  async deleteByMetadata(type: string, key: string, values: string[]): Promise<void> {
    const drop = new Set(values);
    this.samples = this.samples.filter(
      (s) => s.typeIdentifier !== type || !drop.has(s.metadata?.[key] as string),
    );
  }
}

const bolus = (at: number, u: number): PointSample => ({
  type: "point",
  metric: "insulin_bolus_units",
  value: u,
  start: at,
  end: at,
  source: { id: "aaps", platform: "nightscout" },
});
const basal = (at: number, mins: number, u: number): CumulativeSample => ({
  type: "cumulative",
  metric: "insulin_basal_units",
  value: u,
  start: at,
  end: at + mins * M,
  source: { id: "aaps", platform: "nightscout" },
});

const insulinRows = (hk: FakeHK) => hk.samples.filter((s) => s.typeIdentifier === INSULIN);

function build(records: HealthRecord[]) {
  const hk = new FakeHK();
  const apple = new AppleHealthProvider(new AppleHealthKitBridge(hk));
  const ns = new MemoryProvider("nightscout", records, true);
  const engine = new SyncEngine([apple, ns], {
    dedup: { devicePriority: ["aaps"], stepsStrategy: "priority" },
  });
  return { hk, engine };
}

const range = { start: day, end: day + 24 * H };

describe("insulin write → read → count", () => {
  const sent: HealthRecord[] = [
    bolus(day + 5 * H + 26 * M, 0.62),
    bolus(day + 5 * H + 46 * M, 0.77),
    bolus(day + 7 * H + 22 * M, 6.69),
    basal(day + 8 * H + 1 * M, 30, 1.58),
    basal(day + 9 * H + 20 * M, 30, 2.37),
    basal(day + 10 * H + 7 * M, 30, 0.15),
  ];

  it("stores exactly what was sent — count and total match", async () => {
    const { hk, engine } = build(sent);
    await engine.sync(range);

    const rows = insulinRows(hk);
    expect(rows).toHaveLength(sent.length);
    const total = rows.reduce((t, r) => t + r.value, 0);
    const expected = sent.reduce((t, r) => t + (r as any).value, 0);
    expect(total).toBeCloseTo(expected, 6);
  });

  it("every row carries a sync identifier", async () => {
    const { hk, engine } = build(sent);
    await engine.sync(range);
    for (const r of insulinRows(hk)) {
      expect(typeof r.metadata?.[HK_SYNC_IDENTIFIER_KEY]).toBe("string");
    }
  });

  it("syncing repeatedly never grows the count", async () => {
    const { hk, engine } = build(sent);
    await engine.sync(range);
    const after1 = insulinRows(hk).length;
    await engine.sync(range);
    await engine.sync(range);
    expect(insulinRows(hk).length).toBe(after1);
  });

  it("even a forced double write cannot create a duplicate row", async () => {
    // Simulates the race that caused this: two passes writing the same
    // record because neither saw the other's write.
    const { hk, engine } = build(sent);
    await engine.sync(range);
    const before = insulinRows(hk).length;

    const freshEngine = build(sent);
    // Replay the exact same DTOs into the SAME store, bypassing the engine.
    for (const dto of [...hk.samples]) await hk.save({ ...dto, uuid: undefined });

    expect(insulinRows(hk)).toHaveLength(before);
    void freshEngine;
  });

  it("basal and bolus keep their delivery reason", async () => {
    const { hk, engine } = build(sent);
    await engine.sync(range);
    const reasons = insulinRows(hk).map((r) => r.metadata?.["HKInsulinDeliveryReason"]);
    expect(reasons.filter((x) => x === 1)).toHaveLength(3); // basal
    expect(reasons.filter((x) => x === 2)).toHaveLength(3); // bolus
  });
});
