/**
 * Sync ledger: durable record of what this engine has already written to each
 * platform, so repeated syncs are idempotent and nothing echoes back.
 *
 * This module is runtime-agnostic (Node, React Native, browser). The
 * Node-only JSON-file implementation lives in ledger-file.ts
 * (import "health-sync/ledger-file") so bundlers never pull in node:fs.
 * On React Native, persist via `toJSON`/`fromJSON` with any storage API.
 */

import type { EpochMs, Platform } from "../types.js";

export interface LedgerState {
  /** fingerprint -> platforms it has been written to by us. */
  written: Record<string, Platform[]>;
  /** End of the last successfully synced window, per platform. */
  lastSyncedThrough: Partial<Record<Platform, EpochMs>>;
}

export interface SyncLedger {
  hasWritten(fp: string, platform: Platform): boolean;
  markWritten(fp: string, platform: Platform): void;
  getLastSyncedThrough(platform: Platform): EpochMs | undefined;
  setLastSyncedThrough(platform: Platform, ts: EpochMs): void;
  save(): Promise<void>;
}

export class InMemoryLedger implements SyncLedger {
  protected state: LedgerState = { written: {}, lastSyncedThrough: {} };

  hasWritten(fp: string, platform: Platform): boolean {
    return this.state.written[fp]?.includes(platform) ?? false;
  }

  markWritten(fp: string, platform: Platform): void {
    const list = (this.state.written[fp] ??= []);
    if (!list.includes(platform)) list.push(platform);
  }

  getLastSyncedThrough(platform: Platform): EpochMs | undefined {
    return this.state.lastSyncedThrough[platform];
  }

  setLastSyncedThrough(platform: Platform, ts: EpochMs): void {
    this.state.lastSyncedThrough[platform] = ts;
  }

  /** Serialize for persistence (React Native storage, databases, ...). */
  toJSON(): LedgerState {
    return this.state;
  }

  /** Restore from a previously serialized state. */
  static fromJSON(state: Partial<LedgerState> | undefined): InMemoryLedger {
    const ledger = new InMemoryLedger();
    ledger.state = {
      written: state?.written ?? {},
      lastSyncedThrough: state?.lastSyncedThrough ?? {},
    };
    return ledger;
  }

  async save(): Promise<void> {
    // no-op for in-memory; subclasses persist
  }
}
