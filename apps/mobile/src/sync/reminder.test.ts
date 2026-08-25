import { describe, it, expect, vi } from "vitest";

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ granted: false, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ granted: true }),
  cancelScheduledNotificationAsync: async () => {},
  scheduleNotificationAsync: async () => "id",
  SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval" },
}));

const { describeLastSync, isStale, STALE_AFTER_DAYS, noteSyncSucceeded, getLastSyncAt } =
  await import("./reminder.ts");
const { MemoryKV } = await import("../storage/kv.ts");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

describe("describeLastSync", () => {
  it("reads naturally at each scale", () => {
    expect(describeLastSync(null)).toBe("Never synced");
    expect(describeLastSync(NOW - 30_000, NOW)).toBe("Synced just now");
    expect(describeLastSync(NOW - 20 * 60_000, NOW)).toBe("Synced 20 min ago");
    expect(describeLastSync(NOW - 60 * 60_000, NOW)).toBe("Synced 1 hour ago");
    expect(describeLastSync(NOW - 5 * 60 * 60_000, NOW)).toBe("Synced 5 hours ago");
    expect(describeLastSync(NOW - DAY, NOW)).toBe("Synced 1 day ago");
    expect(describeLastSync(NOW - 4 * DAY, NOW)).toBe("Synced 4 days ago");
  });
});

describe("isStale", () => {
  it("trips only past the reminder threshold", () => {
    expect(isStale(null, NOW)).toBe(false);
    expect(isStale(NOW - (STALE_AFTER_DAYS - 1) * DAY, NOW)).toBe(false);
    expect(isStale(NOW - (STALE_AFTER_DAYS + 1) * DAY, NOW)).toBe(true);
  });
});

describe("noteSyncSucceeded", () => {
  it("records the time and survives notifications being unavailable", async () => {
    const kv = new MemoryKV();
    await noteSyncSucceeded(kv, NOW);
    expect(await getLastSyncAt(kv)).toBe(NOW);
  });

  it("moves the timestamp forward on each success", async () => {
    const kv = new MemoryKV();
    await noteSyncSucceeded(kv, NOW);
    await noteSyncSucceeded(kv, NOW + DAY);
    expect(await getLastSyncAt(kv)).toBe(NOW + DAY);
  });
});
