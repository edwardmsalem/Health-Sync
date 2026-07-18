/**
 * In-memory provider: a faithful stand-in for a real platform store, used by
 * tests and the demo. Behaves like HealthKit/Health Connect in the ways the
 * engine cares about: it retains everything written, returns records
 * intersecting the queried range, and honors externalId deletes.
 */

import type { HealthProvider } from "./provider.js";
import type { HealthRecord, Platform, TimeRange } from "../types.js";
import { overlaps } from "../types.js";

export class MemoryProvider implements HealthProvider {
  private records: HealthRecord[] = [];

  constructor(
    readonly platform: Platform,
    seed: HealthRecord[] = [],
  ) {
    this.records = [...seed];
  }

  /** Simulate a device writing native data to the platform. */
  addNative(...records: HealthRecord[]): void {
    this.records.push(...records);
  }

  all(): HealthRecord[] {
    return [...this.records];
  }

  async read(range: TimeRange): Promise<HealthRecord[]> {
    return this.records.filter((r) => overlaps(r, range));
  }

  async write(records: HealthRecord[]): Promise<void> {
    for (const r of records) {
      if (!r.externalId) {
        throw new Error("sync writes must carry an externalId");
      }
    }
    this.records.push(...records.map((r) => ({ ...r })));
  }

  async deleteByExternalIds(externalIds: string[]): Promise<void> {
    const ids = new Set(externalIds);
    this.records = this.records.filter(
      (r) => !r.externalId || !ids.has(r.externalId),
    );
  }
}
