/** SyncLedger persisted through the app's key-value store. */

import { InMemoryLedger, type LedgerState, type SyncLedger } from "health-sync";
import type { KV } from "../storage/kv.ts";

const LEDGER_KEY = "sync-ledger";

class KVLedger extends InMemoryLedger {
  constructor(private readonly kv: KV) {
    super();
  }

  hydrate(state: Partial<LedgerState> | undefined): void {
    this.state = {
      written: state?.written ?? {},
      lastSyncedThrough: state?.lastSyncedThrough ?? {},
    };
  }

  override async save(): Promise<void> {
    await this.kv.set(LEDGER_KEY, JSON.stringify(this.toJSON()));
  }
}

export async function loadLedger(kv: KV): Promise<SyncLedger> {
  const ledger = new KVLedger(kv);
  const raw = await kv.get(LEDGER_KEY);
  if (raw) {
    try {
      ledger.hydrate(JSON.parse(raw) as LedgerState);
    } catch {
      // Corrupt ledger: start fresh — externalId tags on the platforms still
      // prevent duplicates; the ledger is a fast-path only.
    }
  }
  return ledger;
}
