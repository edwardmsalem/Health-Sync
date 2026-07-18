import { describe, it, expect } from "vitest";
import { dedupeSleep } from "./sleep.js";
import { DEFAULT_DEDUP_CONFIG, DedupConfig } from "../config.js";
import type { SleepSession, SourceRef } from "../types.js";

const H = 3_600_000;
const M = 60_000;
const night = Date.UTC(2026, 6, 16, 23, 0, 0); // 23:00

const watch: SourceRef = { id: "apple-watch", platform: "apple" };
const fitbit: SourceRef = { id: "fitbit-air", platform: "google" };

const session = (
  source: SourceRef,
  start: number,
  end: number,
  stages: SleepSession["stages"] = [],
): SleepSession => ({
  type: "sleep",
  source,
  start,
  end,
  stages: stages.length ? stages : [{ stage: "asleep", start, end }],
});

const cfg = (over: Partial<DedupConfig> = {}): DedupConfig => ({
  ...DEFAULT_DEDUP_CONFIG,
  devicePriority: ["apple-watch", "fitbit-air"],
  ...over,
});

const totalMs = (sessions: SleepSession[]) =>
  sessions.reduce((s, x) => s + (x.end - x.start), 0);

describe("dedupeSleep", () => {
  it("keeps only one session when both devices tracked the same night", () => {
    const a = session(watch, night + 10 * M, night + 7 * H + 45 * M);
    const b = session(fitbit, night, night + 8 * H + 5 * M);
    const result = dedupeSleep([a, b], cfg());

    // Primary is the watch (priority). Fitbit contributes only its
    // non-overlapping head (10 min < 15 min threshold -> dropped) and tail
    // (20 min >= threshold -> kept).
    const watchSessions = result.sessions.filter((s) => s.source.id === "apple-watch");
    const fitbitSessions = result.sessions.filter((s) => s.source.id === "fitbit-air");
    expect(watchSessions).toHaveLength(1);
    expect(fitbitSessions).toHaveLength(1);
    expect(fitbitSessions[0]!.start).toBe(night + 7 * H + 45 * M);
    expect(fitbitSessions[0]!.end).toBe(night + 8 * H + 5 * M);

    // No double counting: total tracked sleep < sum of raw sessions.
    expect(totalMs(result.sessions)).toBeLessThan(totalMs([a, b]));
    expect(result.droppedMs).toBeGreaterThan(0);
  });

  it("fully contained duplicate is dropped entirely", () => {
    const outer = session(watch, night, night + 8 * H);
    const inner = session(fitbit, night + H, night + 7 * H);
    const result = dedupeSleep([outer, inner], cfg());
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.source.id).toBe("apple-watch");
    expect(result.droppedMs).toBe(6 * H);
  });

  it("prefers richer stage data when priorities tie", () => {
    const unknownA: SourceRef = { id: "band-a", platform: "apple" };
    const unknownB: SourceRef = { id: "band-b", platform: "google" };
    const plain = session(unknownA, night, night + 8 * H);
    const staged = session(unknownB, night, night + 8 * H, [
      { stage: "light", start: night, end: night + 4 * H },
      { stage: "deep", start: night + 4 * H, end: night + 8 * H },
    ]);
    const result = dedupeSleep([plain, staged], cfg({ devicePriority: [] }));
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.source.id).toBe("band-b");
  });

  it("does not merge separate nights", () => {
    const mon = session(watch, night, night + 8 * H);
    const tue = session(fitbit, night + 24 * H, night + 32 * H);
    const result = dedupeSleep([mon, tue], cfg());
    expect(result.sessions).toHaveLength(2);
    expect(result.droppedMs).toBe(0);
  });

  it("does not merge a night's sleep with a distinct afternoon nap", () => {
    const sleep = session(watch, night, night + 8 * H);
    const nap = session(watch, night + 15 * H, night + 16 * H);
    const result = dedupeSleep([sleep, nap], cfg());
    expect(result.sessions).toHaveLength(2);
  });

  it("clips stage intervals to kept fragments", () => {
    const a = session(watch, night, night + 7 * H);
    const b = session(fitbit, night, night + 8 * H, [
      { stage: "light", start: night, end: night + 6 * H },
      { stage: "rem", start: night + 6 * H, end: night + 8 * H },
    ]);
    const result = dedupeSleep([a, b], cfg());
    const fragment = result.sessions.find((s) => s.source.id === "fitbit-air")!;
    expect(fragment.start).toBe(night + 7 * H);
    expect(fragment.stages).toEqual([
      { stage: "rem", start: night + 7 * H, end: night + 8 * H },
    ]);
  });

  it("handles three devices on one night", () => {
    const a = session(watch, night, night + 8 * H);
    const b = session(fitbit, night - 30 * M, night + 8 * H);
    const phone: SourceRef = { id: "iphone", platform: "apple" };
    const c = session(phone, night + H, night + 9 * H);
    const result = dedupeSleep(
      [a, b, c],
      cfg({ devicePriority: ["apple-watch", "fitbit-air", "iphone"] }),
    );
    // Watch is primary; fitbit adds 30min head; phone adds 1h tail.
    expect(result.sessions).toHaveLength(3);
    expect(totalMs(result.sessions)).toBe(9 * H + 30 * M);
  });
});
