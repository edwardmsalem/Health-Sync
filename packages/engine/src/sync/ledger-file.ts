/**
 * JSON-file-backed ledger for Node CLI / server deployments.
 * Kept out of the main index so React Native bundles never see node:fs —
 * import it as "health-sync/ledger-file".
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { InMemoryLedger, type LedgerState } from "./ledger.js";

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
