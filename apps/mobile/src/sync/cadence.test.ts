import { describe, it, expect } from "vitest";

const { shouldSyncNow, MIN_SYNC_GAP_MS } = await import("./cadence.ts");

const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);

describe("shouldSyncNow", () => {
  it("syncs when nothing has run yet", () => {
    expect(shouldSyncNow(null, NOW)).toBe(true);
  });

  it("holds off inside the minimum gap", () => {
    expect(shouldSyncNow(NOW - 5 * 60_000, NOW)).toBe(false);
    expect(shouldSyncNow(NOW - (MIN_SYNC_GAP_MS - 1), NOW)).toBe(false);
  });

  it("runs once the gap has passed", () => {
    expect(shouldSyncNow(NOW - MIN_SYNC_GAP_MS, NOW)).toBe(true);
    expect(shouldSyncNow(NOW - 2 * MIN_SYNC_GAP_MS, NOW)).toBe(true);
  });

  it("a burst of observer fires collapses to one sync", () => {
    // Five callbacks arrive seconds apart; only the first should proceed.
    let lastSync: number | null = null;
    let syncs = 0;
    for (let i = 0; i < 5; i++) {
      const t = NOW + i * 3000;
      if (shouldSyncNow(lastSync, t)) {
        syncs++;
        lastSync = t;
      }
    }
    expect(syncs).toBe(1);
  });
});
