import { describe, it, expect, beforeEach } from "vitest";
import { withSyncLock, isSyncing, __resetSyncLock } from "./lock.ts";

beforeEach(() => __resetSyncLock());

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("withSyncLock", () => {
  it("runs a lone call", async () => {
    const r = await withSyncLock(async () => 42);
    expect(r).toEqual({ ran: true, result: 42 });
    expect(isSyncing()).toBe(false);
  });

  it("collapses concurrent callers into ONE run", async () => {
    // The actual bug: the Sync button, the background task and two HealthKit
    // observers could all call at once, each reading before any wrote.
    const gate = deferred();
    let runs = 0;
    const work = async () => {
      runs++;
      await gate.promise;
      return runs;
    };

    const all = Promise.all([
      withSyncLock(work),
      withSyncLock(work),
      withSyncLock(work),
      withSyncLock(work),
    ]);
    gate.resolve();
    const results = await all;

    expect(runs).toBe(1);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(results.filter((r) => !r.ran)).toHaveLength(3);
  });

  it("late joiners wait for the in-flight run to finish", async () => {
    const gate = deferred();
    const order: string[] = [];
    const first = withSyncLock(async () => {
      await gate.promise;
      order.push("first-done");
    });
    const second = withSyncLock(async () => {
      order.push("second-ran");
    });
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-done"]); // second never ran its own work
  });

  it("releases the lock after a failure", async () => {
    await expect(
      withSyncLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(isSyncing()).toBe(false);
    const after = await withSyncLock(async () => "ok");
    expect(after).toEqual({ ran: true, result: "ok" });
  });
});
