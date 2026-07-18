/**
 * Sync ledger: durable record of what this engine has already written to each
 * platform, so repeated syncs are idempotent and nothing echoes back.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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

  async save(): Promise<void> {
    // no-op for in-memory
  }
}

/** JSON-file-backed ledger for CLI / server deployments. */
export class FileLedger extends InMemoryLedger {
  constructor(private readonly path: string) {
    super();
  }

  static async load(path: string): Promise<FileLedger> {
    const ledger = new FileLedger(path);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as LedgerState;
      ledger.state = {
        written: parsed.written ?? {},
        lastSyncedThrough: parsed.lastSyncedThrough ?? {},
      };
    } catch {
      // First run: start empty.
    }
    return ledger;
  }

  override async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.state, null, 2), "utf8");
  }
}
