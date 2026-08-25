/**
 * A parsed Google Takeout export exposed as a read-only engine provider.
 *
 * Records are parsed once (from the picked .zip) and held in memory, then a
 * normal engine sync merges them into Apple Health — same dedup, gap-filling
 * and echo prevention as any live source, so importing history can never
 * double-count against Apple Watch data for the same minutes.
 */

import type { HealthProvider, HealthRecord, TimeRange } from "health-sync";

export class TakeoutProvider implements HealthProvider {
  readonly platform = "google" as const;
  readonly readOnly = true;

  constructor(private readonly records: HealthRecord[]) {}

  async read(range: TimeRange): Promise<HealthRecord[]> {
    return this.records.filter((r) =>
      r.start === r.end
        ? r.start >= range.start && r.start < range.end
        : r.start < range.end && r.end >= range.start,
    );
  }

  async write(): Promise<void> {
    throw new Error("Takeout provider is read-only");
  }

  async deleteByExternalIds(): Promise<void> {
    throw new Error("Takeout provider is read-only");
  }

  /** Earliest/latest instant covered, for chunking the import. */
  span(): TimeRange | null {
    if (this.records.length === 0) return null;
    let start = Infinity;
    let end = -Infinity;
    for (const r of this.records) {
      if (r.start < start) start = r.start;
      if (r.end > end) end = r.end;
    }
    return { start, end: end + 1 };
  }
}
