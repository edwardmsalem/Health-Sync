/**
 * Backfill state machine tests. The engine/provider stack is mocked at the
 * module boundary so these exercise chunking, cursor persistence, and
 * rate-limit resume without touching HealthKit or the network.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryKV } from "../storage/kv.ts";
import { FitbitRateLimitError } from "../fitbit/bridge.ts";

const syncMock = vi.fn();

vi.mock("./runSync.ts", () => ({
  DEFAULT_SETTINGS: { devicePriority: [], lookbackDays: 7 },
  buildSyncStack: async () => ({
    engine: { sync: syncMock },
    fitbitBridge: null,
    connected: { fitbit: true, nightscout: false },
  }),
}));

const {
  CHUNK_DAYS,
  cancelBackfill,
  getBackfillState,
  progressOf,
  runBackfill,
  startBackfill,
} = await import("./backfill.ts");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

beforeEach(() => {
  syncMock.mockReset();
  syncMock.mockResolvedValue({ plans: [] });
});

describe("backfill state", () => {
  it("startBackfill sets a target and a cursor at now", async () => {
    const kv = new MemoryKV();
    const state = await startBackfill(60, NOW, kv);
    expect(state.cursorMs).toBe(NOW);
    expect(state.targetStartMs).toBe(NOW - 60 * DAY);
    expect(await getBackfillState(kv)).toEqual(state);
  });

  it("progress reports remaining days and fraction", async () => {
    const state = { targetStartMs: NOW - 60 * DAY, cursorMs: NOW - 30 * DAY, startedAtMs: NOW };
    const p = progressOf(state);
    expect(p.daysTotal).toBe(60);
    expect(p.daysRemaining).toBe(30);
    expect(p.fraction).toBeCloseTo(0.5, 2);
  });

  it("cancel clears the state", async () => {
    const kv = new MemoryKV();
    await startBackfill(30, NOW, kv);
    await cancelBackfill(kv);
    expect(await getBackfillState(kv)).toBeNull();
  });

  it("no-ops when nothing is pending", async () => {
    const result = await runBackfill({ kv: new MemoryKV() });
    expect(result.outcome).toBe("no_backfill");
    expect(syncMock).not.toHaveBeenCalled();
  });
});

describe("runBackfill chunking", () => {
  it("walks backwards one chunk at a time and persists the cursor", async () => {
    const kv = new MemoryKV();
    await startBackfill(60, NOW, kv);

    const result = await runBackfill({ kv, maxChunks: 2 });

    expect(result.outcome).toBe("chunks_done");
    expect(result.chunksProcessed).toBe(2);
    // First chunk is the most recent CHUNK_DAYS, second is the one before it.
    expect(syncMock.mock.calls[0]![0]).toEqual({
      start: NOW - CHUNK_DAYS * DAY,
      end: NOW,
    });
    expect(syncMock.mock.calls[1]![0]).toEqual({
      start: NOW - 2 * CHUNK_DAYS * DAY,
      end: NOW - CHUNK_DAYS * DAY,
    });
    const saved = (await getBackfillState(kv))!;
    expect(saved.cursorMs).toBe(NOW - 2 * CHUNK_DAYS * DAY);
  });

  it("completes and clears state when the target is reached", async () => {
    const kv = new MemoryKV();
    await startBackfill(CHUNK_DAYS, NOW, kv); // exactly one chunk

    const result = await runBackfill({ kv, maxChunks: 5 });

    expect(result.outcome).toBe("completed");
    expect(result.chunksProcessed).toBe(1);
    expect(result.progress!.fraction).toBe(1);
    expect(await getBackfillState(kv)).toBeNull();
  });

  it("never reads past the target start on the final chunk", async () => {
    const kv = new MemoryKV();
    await startBackfill(CHUNK_DAYS + 2, NOW, kv);

    await runBackfill({ kv, maxChunks: 5 });

    const last = syncMock.mock.calls.at(-1)![0];
    expect(last.start).toBe(NOW - (CHUNK_DAYS + 2) * DAY);
  });

  it("pauses cleanly on a rate limit, keeping progress", async () => {
    const kv = new MemoryKV();
    await startBackfill(60, NOW, kv);
    syncMock
      .mockResolvedValueOnce({ plans: [] })
      .mockRejectedValueOnce(new FitbitRateLimitError(1800));

    const result = await runBackfill({ kv, maxChunks: 5 });

    expect(result.outcome).toBe("rate_limited");
    expect(result.chunksProcessed).toBe(1);
    expect(result.message).toMatch(/resumes automatically/);
    // Cursor advanced past the successful chunk only.
    const saved = (await getBackfillState(kv))!;
    expect(saved.cursorMs).toBe(NOW - CHUNK_DAYS * DAY);
  });

  it("resumes from the saved cursor on the next pass", async () => {
    const kv = new MemoryKV();
    await startBackfill(60, NOW, kv);
    await runBackfill({ kv, maxChunks: 1 });
    syncMock.mockClear();

    await runBackfill({ kv, maxChunks: 1 });

    expect(syncMock.mock.calls[0]![0]).toEqual({
      start: NOW - 2 * CHUNK_DAYS * DAY,
      end: NOW - CHUNK_DAYS * DAY,
    });
  });

  it("keeps progress when a chunk fails for a non-rate-limit reason", async () => {
    const kv = new MemoryKV();
    await startBackfill(60, NOW, kv);
    syncMock
      .mockResolvedValueOnce({ plans: [] })
      .mockRejectedValueOnce(new Error("network down"));

    await expect(runBackfill({ kv, maxChunks: 5 })).rejects.toThrow("network down");
    const saved = (await getBackfillState(kv))!;
    expect(saved.cursorMs).toBe(NOW - CHUNK_DAYS * DAY);
  });
});
