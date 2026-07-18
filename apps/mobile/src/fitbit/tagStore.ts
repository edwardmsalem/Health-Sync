/**
 * Fitbit has no metadata field to tag records we author (unlike HealthKit's
 * metadata or Health Connect's clientRecordId), so echo prevention needs a
 * local map: Fitbit logId <-> engine externalId. Persisted via an injected
 * key-value store.
 */

import type { KV } from "../storage/kv.ts";
import type { FitbitWrite } from "./serialize.ts";

interface TagEntry {
  externalId: string;
  kind: FitbitWrite["kind"];
}

const STORE_KEY = "fitbit-tag-store";

export class FitbitTagStore {
  private byLogId = new Map<string, TagEntry>();

  constructor(private readonly kv: KV) {}

  static async load(kv: KV): Promise<FitbitTagStore> {
    const store = new FitbitTagStore(kv);
    const raw = await kv.get(STORE_KEY);
    if (raw) {
      try {
        store.byLogId = new Map(Object.entries(JSON.parse(raw) as Record<string, TagEntry>));
      } catch {
        // Corrupt store: start fresh; worst case we re-skip known records.
      }
    }
    return store;
  }

  async save(): Promise<void> {
    await this.kv.set(STORE_KEY, JSON.stringify(Object.fromEntries(this.byLogId)));
  }

  record(logId: string | number, externalId: string, kind: FitbitWrite["kind"]): void {
    this.byLogId.set(String(logId), { externalId, kind });
  }

  externalIdFor(logId: string | number): string | undefined {
    return this.byLogId.get(String(logId))?.externalId;
  }

  /** Find (logId, kind) for an externalId, for deletes. */
  entryFor(externalId: string): { logId: string; kind: FitbitWrite["kind"] } | undefined {
    for (const [logId, entry] of this.byLogId) {
      if (entry.externalId === externalId) return { logId, kind: entry.kind };
    }
    return undefined;
  }

  forget(logId: string): void {
    this.byLogId.delete(logId);
  }
}
