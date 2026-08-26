import { describe, it, expect } from "vitest";
import { MemoryKV } from "../storage/kv.ts";
import { resetSyncState, SYNC_STATE_KEYS } from "./reset.ts";

describe("resetSyncState", () => {
  it("clears every remembered key", async () => {
    const kv = new MemoryKV();
    for (const k of SYNC_STATE_KEYS) await kv.set(k, "something");
    await kv.set("nightscout-url", "https://keep.me");

    await resetSyncState(kv);

    for (const k of SYNC_STATE_KEYS) expect(await kv.get(k)).toBe("");
    // Connection settings are NOT sync state and must survive.
    expect(await kv.get("nightscout-url")).toBe("https://keep.me");
  });

  it("is safe to run when nothing was stored", async () => {
    const kv = new MemoryKV();
    await expect(resetSyncState(kv)).resolves.toBeUndefined();
  });
});
